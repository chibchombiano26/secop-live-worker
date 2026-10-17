import json
import pathlib
import sys
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server


class FakeRunner:
    def __init__(self, outputs=None, failure=None):
        self.outputs = outputs or []
        self.failure = failure
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if self.failure:
            raise self.failure
        stdout = self.outputs.pop(0) if self.outputs else b""
        if isinstance(stdout, str):
            stdout = stdout.encode()
        return server.subprocess.CompletedProcess(args, 0, stdout=stdout, stderr=b"")


class ExtractTests(unittest.TestCase):
    def test_extracts_every_page_and_returns_complete_document(self):
        runner = FakeRunner(["Pages:          3\n", "", "first\fsecond\fthird\f"])

        result = server.extract_pdf(b"%PDF-test", runner=runner)

        self.assertEqual(result["parserVersion"], "ocrmypdf-tesseract-v1")
        self.assertEqual(result["pageCount"], 3)
        self.assertTrue(result["complete"])
        self.assertEqual(result["pages"], [
            {"page": 1, "text": "first"},
            {"page": 2, "text": "second"},
            {"page": 3, "text": "third"},
        ])
        ocr_call = next(args for args, _ in runner.calls if args[0] == "ocrmypdf")
        self.assertEqual(ocr_call[1:5], ["--language", "spa+eng", "--skip-text", "--rotate-pages"])

    def test_preserves_blank_pages_with_warning(self):
        runner = FakeRunner(["Pages: 2\n", "", "text\f\f"])

        result = server.extract_pdf(b"%PDF-test", runner=runner)

        self.assertTrue(result["complete"])
        self.assertEqual(result["pages"][1], {"page": 2, "text": ""})
        self.assertEqual(len(result["warnings"]), 1)

    def test_rejects_non_pdf_input(self):
        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"not pdf", runner=FakeRunner())
        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.code, "OCR_INVALID_PDF")

    def test_rejects_pdf_over_20_pages(self):
        runner = FakeRunner(["Pages: 21\n"])
        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner)
        self.assertEqual(ctx.exception.status, 413)
        self.assertEqual(ctx.exception.code, "OCR_PAGE_LIMIT")

    def test_rejects_encrypted_pdf(self):
        runner = FakeRunner(["Pages: 1\nEncrypted: yes\n"])
        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner)
        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.code, "OCR_ENCRYPTED_PDF")

    def test_rejects_encrypted_pdf_with_pdfinfo_permission_details(self):
        runner = FakeRunner(["Pages: 1\nEncrypted: yes (print:yes copy:yes change:no)\n"])
        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner)
        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.code, "OCR_ENCRYPTED_PDF")

    def test_enforces_ocr_deadline(self):
        runner = FakeRunner(failure=server.subprocess.TimeoutExpired("ocrmypdf", 78))
        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner)
        self.assertEqual(ctx.exception.status, 504)
        self.assertEqual(ctx.exception.code, "OCR_TIMEOUT")


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(
            processor=lambda content: {
                "parserVersion": "ocrmypdf-tesseract-v1",
                "pages": [{"page": 1, "text": "ok"}],
                "warnings": [], "complete": True, "pageCount": 1,
            },
            max_bytes=16,
        ))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path="/v1/extract", body=b"%PDF-test", headers=None):
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        base = {"Content-Type": "application/pdf", "Content-Length": str(len(body))}
        base.update(headers or {})
        conn.request("POST", path, body=body, headers=base)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw) if raw else None

    def test_extract_route_returns_json_contract(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body["pages"][0]["text"], "ok")

    def test_rejects_wrong_route_and_method(self):
        self.assertEqual(self.request(path="/other")[0], 404)
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        conn.request("GET", "/v1/extract")
        response = conn.getresponse()
        response.read()
        self.assertEqual(response.status, 405)
        conn.close()

    def test_rejects_wrong_media_type(self):
        status, _ = self.request(headers={"Content-Type": "application/json"})
        self.assertEqual(status, 415)

    def test_rejects_oversized_request_before_reading_body(self):
        status, body = self.request(body=b"12345678901234567")
        self.assertEqual(status, 413)
        self.assertEqual(body["error"], "OCR_FILE_LIMIT")

    def test_returns_429_while_another_job_owns_the_worker(self):
        entered = threading.Event()
        release = threading.Event()

        def slow_processor(content):
            entered.set()
            release.wait(timeout=2)
            return {"pages": [], "warnings": [], "complete": True, "pageCount": 0}

        self.server.shutdown()
        self.server.server_close()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(
            processor=slow_processor, max_bytes=16,
        ))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        first_result = []
        first = threading.Thread(target=lambda: first_result.append(self.request()))
        first.start()
        self.assertTrue(entered.wait(timeout=1))
        second_status, second_body = self.request()
        release.set()
        first.join(timeout=2)
        self.assertEqual(second_status, 429)
        self.assertEqual(second_body["error"], "OCR_BUSY")
        self.assertEqual(first_result[0][0], 200)


if __name__ == "__main__":
    unittest.main()
