import json
import pathlib
import sys
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

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

    def test_extracts_bounded_range_from_pdf_over_20_pages_with_original_numbers(self):
        runner = FakeRunner([
            "Pages: 22\n",  # Original PDF.
            "",  # pdfseparate.
            "",  # pdfunite.
            "",  # ocrmypdf.
            "first\fsecond\f",  # pdftotext for final short range.
        ])

        result = server.extract_pdf(b"%PDF-test", runner=runner, start_page=21, page_count=5)

        self.assertEqual(result["pageCount"], 22)
        self.assertEqual(result["startPage"], 21)
        self.assertEqual(result["endPage"], 22)
        self.assertEqual(result["nextPage"], None)
        self.assertTrue(result["complete"])
        self.assertEqual(result["pages"], [
            {"page": 21, "text": "first"},
            {"page": 22, "text": "second"},
        ])
        separate_call = next(args for args, _ in runner.calls if args[0] == "pdfseparate")
        self.assertEqual(separate_call[1:5], ["-f", "21", "-l", "22"])
        unite_call = next(args for args, _ in runner.calls if args[0] == "pdfunite")
        self.assertEqual(Path(unite_call[-1]).name, "batch.pdf")
        ocr_call = next(args for args, _ in runner.calls if args[0] == "ocrmypdf")
        self.assertEqual(Path(ocr_call[-2]).name, "batch.pdf")

    def test_reports_next_original_page_for_incomplete_range(self):
        runner = FakeRunner(["Pages: 24\n", "", "", "", "page 21\fpage 22\f"])

        result = server.extract_pdf(b"%PDF-test", runner=runner, start_page=21, page_count=2)

        self.assertEqual(result["pageCount"], 24)
        self.assertEqual(result["startPage"], 21)
        self.assertEqual(result["endPage"], 22)
        self.assertEqual(result["nextPage"], 23)
        self.assertFalse(result["complete"])
        self.assertEqual([page["page"] for page in result["pages"]], [21, 22])

    def test_ranged_pdf_does_not_silently_pad_missing_page_text(self):
        runner = FakeRunner(["Pages: 22\n", "", "", "", "only one\f"])

        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner, start_page=21, page_count=2)

        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.code, "OCR_INVALID_PDF")

    def test_ranged_pdf_does_not_silently_truncate_extra_page_text(self):
        runner = FakeRunner(["Pages: 22\n", "", "", "", "one\ftwo\fthree\f"])

        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner, start_page=21, page_count=2)

        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.code, "OCR_INVALID_PDF")

    def test_rejects_page_range_start_beyond_document(self):
        runner = FakeRunner(["Pages: 22\n"])

        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner, start_page=23, page_count=1)

        self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(ctx.exception.code, "OCR_INVALID_PAGE_RANGE")

    def test_rejects_page_range_larger_than_five_pages(self):
        runner = FakeRunner(["Pages: 22\n"])

        with self.assertRaises(server.RequestError) as ctx:
            server.extract_pdf(b"%PDF-test", runner=runner, start_page=1, page_count=6)

        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.code, "OCR_INVALID_PAGE_RANGE")

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
        cls.received_ranges = []

        def processor(content, **kwargs):
            cls.received_ranges.append(kwargs)
            return {
                "parserVersion": "ocrmypdf-tesseract-v1",
                "pages": [{"page": 1, "text": "ok"}],
                "warnings": [], "complete": True, "pageCount": 1,
            }

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(
            processor=processor,
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

    def test_forwards_validated_page_range_to_processor(self):
        self.received_ranges.clear()

        status, _ = self.request(headers={"x-ocr-start-page": "21", "x-ocr-page-count": "5"})

        self.assertEqual(status, 200)
        self.assertEqual(self.received_ranges, [{"start_page": 21, "page_count": 5}])

    def test_rejects_partial_or_invalid_page_range_headers(self):
        cases = [
            ({"x-ocr-start-page": "1"}, 400),
            ({"x-ocr-start-page": "0", "x-ocr-page-count": "1"}, 400),
            ({"x-ocr-start-page": "1x", "x-ocr-page-count": "1"}, 400),
            ({"x-ocr-start-page": "1", "x-ocr-page-count": "6"}, 400),
        ]
        for headers, expected_status in cases:
            with self.subTest(headers=headers):
                status, body = self.request(headers=headers)
                self.assertEqual(status, expected_status)
                self.assertEqual(body["error"], "OCR_INVALID_PAGE_RANGE")

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
