"""Detect and safely evaluate simple arithmetic in a user message.

Used to drive the math-answer animation + hologram: if the message contains a
plain arithmetic expression (addition / subtraction / multiplication /
division / powers, written with symbols or words), return the normalized
display form and the computed answer. Returns None for anything that isn't a
clear arithmetic expression — the LLM still answers in words either way.

Evaluation is done over a whitelisted AST (never `eval`), so arbitrary code
in the message can't run.
"""

from __future__ import annotations

import ast
import operator
import re
from typing import Optional

_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

# Word forms → operator symbols (longest/most specific first).
_WORD_SUBS = [
    (r"\bmultiplied by\b", "*"),
    (r"\bdivided by\b", "/"),
    (r"\btimes\b", "*"),
    (r"\bover\b", "/"),
    (r"\bplus\b", "+"),
    (r"\badded to\b", "+"),
    (r"\bminus\b", "-"),
    (r"\bsubtract(?:ed)?\b", "-"),
    (r"\bto the power of\b", "^"),
    (r"\bsquared\b", "^2"),
    (r"\bcubed\b", "^3"),
]

# An arithmetic expression: numbers joined by at least one operator.
_EXPR_RE = re.compile(r"[-+]?\d+(?:\.\d+)?(?:\s*[-+*/^]\s*[-+]?\d+(?:\.\d+)?)+")

# Spoken/typed number words → integers, so "twelve times four" works (common
# from voice/ASR). Covers units, teens, tens, and hundred/thousand/million.
_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
         "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_SCALES = {"hundred": 100, "thousand": 1000, "million": 1_000_000}
_NUMWORDS = set(_UNITS) | set(_TENS) | set(_SCALES) | {"and"}


def _run_to_int(words: list[str]) -> int:
    total = current = 0
    for w in words:
        if w in _UNITS:
            current += _UNITS[w]
        elif w in _TENS:
            current += _TENS[w]
        elif w == "hundred":
            current = (current or 1) * 100
        elif w in ("thousand", "million"):
            current = (current or 1) * _SCALES[w]
            total += current
            current = 0
        # "and" is filler ("one hundred and five")
    return total + current


def _words_to_numbers(s: str) -> str:
    """Replace runs of number words with their digit value."""
    tokens = re.findall(r"[a-z]+|\d+\.?\d*|\S", s)
    out: list[str] = []
    run: list[str] = []

    def flush() -> None:
        if any(w in _UNITS or w in _TENS or w in _SCALES for w in run):
            out.append(str(_run_to_int(run)))
        run.clear()

    for tok in tokens:
        if tok in _NUMWORDS:
            run.append(tok)
        else:
            flush()
            out.append(tok)
    flush()
    return " ".join(out)


def _eval(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant):  # numbers
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError("non-numeric constant")
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    raise ValueError("unsupported expression")


def _format_number(value: float) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    # round long decimals for display
    rounded = round(value, 4)
    return str(int(rounded)) if float(rounded).is_integer() else str(rounded)


def solve(text: str) -> Optional[dict[str, str]]:
    """Return {"expr": "5 × 3", "answer": "15"} or None if not arithmetic."""
    if not text:
        return None
    s = text.lower().replace("×", "*").replace("÷", "/")
    s = _words_to_numbers(s)  # "twelve times four" → "12 times 4"
    for pattern, repl in _WORD_SUBS:
        s = re.sub(pattern, repl, s)
    # standalone 'x' between numbers means multiply (e.g. "2 x 3")
    s = re.sub(r"(?<=\d)\s*x\s*(?=\d)", "*", s)

    match = _EXPR_RE.search(s)
    if not match:
        return None
    raw = match.group(0).replace("^", "**")
    try:
        value = _eval(ast.parse(raw, mode="eval"))
    except (ValueError, SyntaxError, ZeroDivisionError, KeyError, OverflowError):
        return None
    if not isinstance(value, (int, float)):
        return None

    display = match.group(0).replace("*", "×").replace("/", "÷").replace("^", "^")
    display = re.sub(r"\s+", " ", display).strip()
    return {"expr": display, "answer": _format_number(value)}
