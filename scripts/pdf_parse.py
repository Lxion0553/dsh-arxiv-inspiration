#!/usr/bin/env python3
"""Full-text PDF extraction via PyMuPDF. Prints the complete text; no truncation."""
import sys

try:
    import pymupdf as fitz  # PyMuPDF ≥1.24 canonical import; `fitz` is deprecated
except ImportError:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print(
            "ERROR: pymupdf is not installed. Install it with: pip install pymupdf",
            file=sys.stderr,
        )
        sys.exit(3)


def parse(pdf_path: str) -> str:
    doc = fitz.open(pdf_path)
    try:
        return "".join(page.get_text() for page in doc)
    finally:
        doc.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: pdf_parse.py <pdf-path>", file=sys.stderr)
        sys.exit(2)
    sys.stdout.write(parse(sys.argv[1]))
