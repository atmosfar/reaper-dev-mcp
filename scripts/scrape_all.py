#!/usr/bin/env python3
"""
Run all scrapers/parsers to update the API data.

Inputs, per dataset:
  JSFX      none; scrape_jsfx.py downloads the docs from reaper.fm itself
  ReaScript one HTML file, in order of preference:
              --reascript <file>       saved from REAPER: Help > ReaScript Documentation
                                        (recommended; also carries the extension functions)
              --reascript download     the published reaper.fm page (stock functions only)
              <repo root>/reascripthelp.html   (left there by a previous run)
              a pasted path at the prompt, or 'download', or Enter to skip
  Actions   one HTML file: --actions <file>, or a pasted path at the prompt,
            or Enter to skip. (REAPER: Actions list window > Save list... (HTML))

In a terminal, a missing input is asked for at a prompt: paste the file
path (re-asked if it does not exist), or Enter to skip that dataset.
Without a terminal (CI, piped input) nothing prompts: an input requested
with a flag fails the run, one that was not is skipped with instructions.
Exit code is 1 if anything that ran or was explicitly requested failed.
"""

import argparse
import subprocess
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
DEFAULT_REASCRIPt_HTML = REPO_ROOT / "reascripthelp.html"
OFFICIAL_URL = "https://www.reaper.fm/sdk/reascript/reascripthelp.html"
INTERACTIVE = sys.stdin.isatty()


def run(name: str, cmd: list[str]) -> int:
    # stdout/stderr are inherited on purpose: live output, and if a child ever
    # prompts, the prompt is visible instead of buffering into a dead pipe.
    print(f"\n--- {name} ---")
    try:
        return subprocess.run(cmd).returncode
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        return 127


def as_path(raw: str) -> Path:
    """A plain path, or a file:// URL copied from a browser address bar."""
    if raw.lower().startswith("file://"):
        return Path(url2pathname(urlparse(raw).path))
    return Path(raw).expanduser()


def ask_for_file(title: str, body: str, allow_download: bool = False):
    """Prompt until the user pastes an existing path, 'download', or Enter.

    Returns the Path, the string 'download' (ReaScript only), or None for
    skip / EOF. A path that does not exist is re-asked for.
    """
    choice = (
        "Path to HTML file, or 'download' for the official page"
        if allow_download
        else "Path to HTML file"
    )
    print(f"\n=== {title} ===\n\n{body}\n")
    while True:
        try:
            raw = input(f"{choice}, or Enter to skip: ").strip()
        except EOFError:
            print()
            return None
        if not raw:
            return None
        if allow_download and raw.lower() == "download":
            return "download"
        candidate = as_path(raw)
        if candidate.exists():
            return candidate
        print(f"  not found: {candidate}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run all API scrapers/parsers. Missing inputs are asked "
                    "for at a prompt in a terminal, skipped with instructions "
                    "without one; an explicitly requested input that is "
                    "missing fails the run.",
    )
    parser.add_argument(
        "--reascript",
        metavar="FILE|download",
        help="ReaScript help HTML: a file path, or 'download' to fetch the "
             "official reaper.fm page (stock functions only).",
    )
    parser.add_argument(
        "--actions",
        metavar="FILE",
        help="REAPER Actions-list HTML export "
             "(Actions list window > Save list...).",
    )
    args = parser.parse_args()

    # --- gather inputs (the prompts, if any, happen all up front) ------------
    reascript_input: Path | str | None = None
    if args.reascript == "download":
        reascript_input = "download"
    elif args.reascript:
        candidate = as_path(args.reascript)
        if candidate.exists():
            reascript_input = candidate
        else:
            print(
                f"note: {candidate} not found"
                + ("; asking again" if INTERACTIVE else ""),
                file=sys.stderr,
            )
    elif DEFAULT_REASCRIPt_HTML.exists():
        reascript_input = DEFAULT_REASCRIPt_HTML

    if reascript_input is None and INTERACTIVE:
        reascript_input = ask_for_file(
            "ReaScript HTML",
            "  In REAPER: Help > ReaScript Documentation, then copy the URL which opens in your browser.\n"
            "  This locally-generated version also includes functions registered by extensions (SWS_*, ImGui_*...),\n"
            "  which the website does not.",
            allow_download=True,
        )

    actions_input: Path | None = None
    if args.actions:
        candidate = as_path(args.actions)
        if candidate.exists():
            actions_input = candidate
        else:
            print(
                f"note: {candidate} not found"
                + ("; asking again" if INTERACTIVE else ""),
                file=sys.stderr,
            )

    if actions_input is None and INTERACTIVE:
        actions_input = ask_for_file(
            "Actions HTML",
            "  In REAPER: Help > Actions list as HTML.\n"
            "  This locally-generated version also includes actions registered by extensions (SWS: ...),\n"
            "  which the website does not.",
        )

    results: dict[str, str] = {}

    # --- JSFX: needs no input --------------------------------------------------
    rc = run("JSFX", ["python3", str(SCRIPTS_DIR / "scrape_jsfx.py")])
    results["JSFX"] = "ok" if rc == 0 else "FAILED"
    if rc != 0:
        print(f"  scraper exited {rc}", file=sys.stderr)

    # --- ReaScript ----------------------------------------------------------------
    if reascript_input is None:
        results["ReaScript"] = "FAILED" if args.reascript else "SKIPPED"
        if not args.reascript and not INTERACTIVE:
            print(
                "ReaScript: no input (and no terminal to ask in). Get one of:\n"
                "  1. REAPER: Help > ReaScript Documentation, save the page as HTML,\n"
                "     then run again with --reascript <file>   (recommended)\n"
                "  2. run again with --reascript download      (official page;\n"
                "     stock functions only)"
            )
    elif reascript_input == "download":
        try:
            with urllib.request.urlopen(OFFICIAL_URL, timeout=120) as response:
                DEFAULT_REASCRIPt_HTML.write_bytes(response.read())
            print(f"Downloaded {OFFICIAL_URL}\n  -> {DEFAULT_REASCRIPt_HTML}")
            reascript_input = DEFAULT_REASCRIPt_HTML
        except Exception as e:
            print(f"error: download failed: {e}", file=sys.stderr)
            results["ReaScript"] = "FAILED"

    if isinstance(reascript_input, Path) and "ReaScript" not in results:
        rc = run(
            "ReaScript",
            ["python3", str(SCRIPTS_DIR / "scrape_reascript.py"), str(reascript_input)],
        )
        results["ReaScript"] = "ok" if rc == 0 else "FAILED"
        if rc != 0:
            print(f"  scraper exited {rc}", file=sys.stderr)

    # --- Actions --------------------------------------------------------------------
    if actions_input is None:
        results["Actions"] = "FAILED" if args.actions else "SKIPPED"
        if not args.actions and not INTERACTIVE:
            print(
                "Actions: no input (and no terminal to ask in). In REAPER:\n"
                "Actions list window > Save list... (HTML), then run again\n"
                "with --actions <file>."
            )
    else:
        rc = run(
            "Actions",
            ["python3", str(SCRIPTS_DIR / "parse_actions.py"), str(actions_input)],
        )
        results["Actions"] = "ok" if rc == 0 else "FAILED"
        if rc != 0:
            print(f"  parser exited {rc}", file=sys.stderr)

    # --- Summary --------------------------------------------------------------------
    print("\n=== Summary ===")
    for name, status in results.items():
        marker = "  " if status == "ok" else "!!"
        print(f"{marker}{status:8} {name}")

    sys.exit(1 if any(s == "FAILED" for s in results.values()) else 0)


if __name__ == "__main__":
    main()
