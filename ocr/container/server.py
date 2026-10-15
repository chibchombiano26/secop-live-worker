"""Small, single-job HTTP service for CPU-based PDF OCR."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

MAX_REQUEST_BYTES = 25 * 1024 * 1024
MAX_PAGES = 20
PROCESS_DEADLINE_SECONDS = 78
PARSER_VERSION = "ocrmypdf-tesseract-v1"


class RequestError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _run_subprocess(args: list[str], *, timeout: float, **_kwargs):
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise subprocess.TimeoutExpired(args, timeout) from None
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, args, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def _run(args: list[str], *, timeout: float, runner: Callable | None = None):
    return (runner or _run_subprocess)(
        args,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )


def _run_before_deadline(args: list[str], deadline: float, runner: Callable):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise subprocess.TimeoutExpired(args, PROCESS_DEADLINE_SECONDS)
    return _run(args, timeout=remaining, runner=runner)


def _decode_stdout(result) -> str:
    stdout = result.stdout
    if isinstance(stdout, bytes):
        return stdout.decode("utf-8", errors="replace")
    return str(stdout or "")


def _page_count(pdf_path: Path, *, deadline: float, runner: Callable) -> int:
    try:
        result = _run_before_deadline(["pdfinfo", str(pdf_path)], deadline, runner)
    except subprocess.CalledProcessError as exc:
        error_text = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else str(exc.stderr or "")
        code = "OCR_ENCRYPTED_PDF" if re.search(r"encrypt|password", error_text, re.IGNORECASE) else "OCR_INVALID_PDF"
        raise RequestError(422, code, "PDF could not be read") from None
    info = _decode_stdout(result)
    if re.search(r"^Encrypted:\s+yes\b", info, re.MULTILINE | re.IGNORECASE):
        raise RequestError(422, "OCR_ENCRYPTED_PDF", "Encrypted PDFs are not supported")
    match = re.search(r"^Pages:\s+(\d+)\s*$", info, re.MULTILINE)
    if not match:
        raise RequestError(422, "OCR_INVALID_PDF", "Could not determine PDF page count")
    page_count = int(match.group(1))
    if page_count < 1:
        raise RequestError(422, "OCR_INVALID_PDF", "PDF has no pages")
    if page_count > MAX_PAGES:
        raise RequestError(413, "OCR_PAGE_LIMIT", f"PDF exceeds the {MAX_PAGES}-page OCR limit")
    return page_count


def extract_pdf(pdf_bytes: bytes, *, runner: Callable | None = None) -> dict:
    """OCR a complete PDF and return one layout-preserving text entry per page."""
    if not isinstance(pdf_bytes, bytes) or not pdf_bytes.startswith(b"%PDF-"):
        raise RequestError(422, "OCR_INVALID_PDF", "Request body must contain raw PDF bytes")
    if len(pdf_bytes) > MAX_REQUEST_BYTES:
        raise RequestError(413, "OCR_FILE_LIMIT", "PDF exceeds the 25 MiB request limit")

    deadline = time.monotonic() + PROCESS_DEADLINE_SECONDS
    try:
        with tempfile.TemporaryDirectory(prefix="savia-ocr-") as temp_dir:
            input_path = Path(temp_dir) / "input.pdf"
            output_path = Path(temp_dir) / "ocr.pdf"
            input_path.write_bytes(pdf_bytes)

            page_count = _page_count(input_path, deadline=deadline, runner=runner)
            _run_before_deadline(
                [
                    "ocrmypdf",
                    "--language", "spa+eng",
                    "--skip-text",
                    "--rotate-pages",
                    "--deskew",
                    "--jobs", "1",
                    "--optimize", "0",
                    "--output-type", "pdf",
                    str(input_path),
                    str(output_path),
                ],
                deadline,
                runner,
            )
            text_result = _run_before_deadline(
                ["pdftotext", "-layout", str(output_path), "-"],
                deadline,
                runner,
            )
    except RequestError:
        raise
    except subprocess.TimeoutExpired:
        raise RequestError(504, "OCR_TIMEOUT", "PDF OCR exceeded its processing deadline") from None
    except subprocess.CalledProcessError:
        # Keep stderr and document contents out of the HTTP response and logs.
        raise RequestError(422, "OCR_INVALID_PDF", "PDF OCR could not process this document") from None
    except OSError:
        raise RequestError(500, "OCR_INTERNAL_ERROR", "PDF OCR service could not access its processing tools") from None

    raw_pages = _decode_stdout(text_result).split("\f")
    if raw_pages and not raw_pages[-1].strip():
        raw_pages.pop()
    raw_pages = raw_pages[:page_count]
    raw_pages.extend([""] * (page_count - len(raw_pages)))

    pages = [{"page": index + 1, "text": text.strip()} for index, text in enumerate(raw_pages)]
    warnings = [
        f"Page {page['page']} contains no extractable text; manual review may be needed"
        for page in pages
        if not page["text"]
    ]
    return {
        "parserVersion": PARSER_VERSION,
        "pages": pages,
        "warnings": warnings,
        "complete": True,
        "pageCount": page_count,
    }


def make_handler(
    processor: Callable[[bytes], dict] = extract_pdf,
    *,
    max_bytes: int = MAX_REQUEST_BYTES,
):
    job_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, _format, *args):
            # Suppress request data and tool details from container logs.
            return

        def _json(self, status: int, payload: dict):
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            if self.path == "/health":
                self._json(200, {"status": "ok"})
                return
            self._json(405, {"error": "Method not allowed"})

        def do_POST(self):
            if self.path != "/v1/extract":
                self._json(404, {"error": "Not found"})
                return
            media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if media_type != "application/pdf":
                self._json(415, {"error": "OCR_INVALID_PDF", "message": "Content-Type must be application/pdf"})
                return
            raw_length = self.headers.get("Content-Length")
            try:
                length = int(raw_length) if raw_length is not None else -1
            except ValueError:
                length = -1
            if length < 0:
                self._json(411, {"error": "OCR_INVALID_PDF", "message": "Content-Length is required"})
                return
            if length == 0:
                self._json(422, {"error": "OCR_INVALID_PDF", "message": "PDF request body is empty"})
                return
            if length > max_bytes:
                self._json(413, {"error": "OCR_FILE_LIMIT", "message": "PDF exceeds the 25 MiB request limit"})
                return
            if not job_lock.acquire(blocking=False):
                self._json(429, {"error": "OCR_BUSY", "message": "OCR worker is busy"})
                return

            try:
                pdf_bytes = self.rfile.read(length)
                if len(pdf_bytes) != length:
                    self._json(422, {"error": "OCR_INVALID_PDF", "message": "Incomplete PDF request body"})
                    return
                try:
                    result = processor(pdf_bytes)
                except RequestError as exc:
                    self._json(exc.status, {"error": exc.code, "message": exc.message})
                    return
                except Exception:
                    self._json(500, {"error": "OCR_INTERNAL_ERROR", "message": "OCR failed unexpectedly"})
                    return
                self._json(200, result)
            finally:
                job_lock.release()

    return Handler


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer((host, port), make_handler())
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
