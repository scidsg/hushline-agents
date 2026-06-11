from __future__ import annotations

import plistlib
import sys
from pathlib import Path

from defusedxml import ElementTree as ET

REPO_ROOT = Path(__file__).resolve().parents[1]
SOCIAL_PLIST_DIR = REPO_ROOT / "social" / "deploy" / "launchd"
SALES_PLIST_DIR = REPO_ROOT / "sales" / "deploy" / "launchd"
RUNNER_PLIST_DIR = REPO_ROOT / "deploy" / "launchd"
VALUE_TAGS = frozenset(
    {
        "array",
        "data",
        "date",
        "dict",
        "false",
        "integer",
        "real",
        "string",
        "true",
    }
)
SCALAR_TAGS = VALUE_TAGS - {"array", "dict"}


class PlistValidationError(ValueError):
    """Raised when a launchd plist template is not strict XML plist syntax."""


def _format_context(path: Path, element: ET.Element) -> str:
    return f"{path}: <{element.tag}>"


def _require_no_child_elements(path: Path, element: ET.Element) -> None:
    if len(element):
        raise PlistValidationError(
            f"{_format_context(path, element)} must not contain child elements"
        )


def _validate_value(path: Path, element: ET.Element) -> None:
    if element.tag not in VALUE_TAGS:
        raise PlistValidationError(f"{path}: unknown plist tag <{element.tag}>")

    if element.tag == "dict":
        _validate_dict(path, element)
    elif element.tag == "array":
        for child in element:
            _validate_value(path, child)
    elif element.tag in SCALAR_TAGS:
        _require_no_child_elements(path, element)


def _validate_dict(path: Path, element: ET.Element) -> None:
    children = list(element)
    if len(children) % 2 != 0:
        raise PlistValidationError(f"{_format_context(path, element)} has an unpaired key")

    for key_element, value_element in zip(children[0::2], children[1::2], strict=True):
        if key_element.tag != "key":
            raise PlistValidationError(
                f"{path}: expected <key> in <dict>, found <{key_element.tag}>"
            )
        _require_no_child_elements(path, key_element)
        _validate_value(path, value_element)


def validate_plist_path(plist_path: Path) -> None:
    plist_bytes = plist_path.read_bytes()
    try:
        root = ET.fromstring(plist_bytes)
    except ET.ParseError as exc:
        raise PlistValidationError(f"{plist_path}: invalid XML: {exc}") from exc

    if root.tag != "plist":
        raise PlistValidationError(f"{plist_path}: expected <plist> root, found <{root.tag}>")

    root_values = list(root)
    if len(root_values) != 1:
        raise PlistValidationError(
            f"{plist_path}: expected exactly one top-level plist object, found {len(root_values)}"
        )

    _validate_value(plist_path, root_values[0])
    try:
        plistlib.loads(plist_bytes)
    except plistlib.InvalidFileException as exc:
        raise PlistValidationError(f"{plist_path}: invalid plist: {exc}") from exc


def main() -> int:
    failed = False
    plist_paths = [
        *sorted(SOCIAL_PLIST_DIR.glob("*.plist")),
        *sorted(SALES_PLIST_DIR.glob("*.plist")),
        *sorted(RUNNER_PLIST_DIR.glob("*.plist")),
    ]
    for plist_path in plist_paths:
        try:
            validate_plist_path(plist_path)
        except PlistValidationError as exc:
            failed = True
            print(exc, file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
