"""The metric expression language — small on purpose, and never `eval`.

GRAMMAR (all of it)
-------------------
    expr    := term (('+' | '-') term)*
    term    := factor (('*' | '/') factor)*
    factor  := NUMBER | NAME | '(' expr ')' | '-' factor | FUNC '(' args ')'
    FUNC    := 'abs' | 'annualize'

`×` and `÷` are accepted as spellings of `*` and `/`. Nothing else exists: no
comparisons, no exponent, no attribute access, no subscripts, no strings, no
keywords. The string is parsed with Python's `ast` in ``mode="eval"`` and then
walked against a strict WHITELIST of node types — an unknown node is a
rejection naming itself, so the failure mode of `eval` (a formula that is
secretly a program) cannot exist here.

Two consumers, one walk:

* ``infer(...)``    dimension inference at REGISTRATION, using the unit algebra.
* ``evaluate(...)`` arithmetic at evaluation time. Division by zero raises
                    ``EvalRefusal`` — a structured refusal, never infinity and
                    never a fabricated zero.

`annualize(x)` scales a windowed quantity to a year using the ACTUAL window
length the evaluator passes in — a dimensionless factor, so the quantity's
dimension is preserved. It exists for the future EPI-shaped composites and is
a no-op on nothing: with no window it is a refusal.
"""

from __future__ import annotations

import ast

from .units import DIMENSIONLESS, DimensionError, Qty, add_sub, mul_div


class ExprError(ValueError):
    """The formula is not in the language. Raised at registration."""


class EvalRefusal(Exception):
    """Arithmetic that must not produce a number (division by zero)."""

    def __init__(self, status: str, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


_FUNCS = ("abs", "annualize")

_BINOPS: dict[type, str] = {
    ast.Add: "+",
    ast.Sub: "-",
    ast.Mult: "*",
    ast.Div: "/",
}


def parse(formula: str) -> ast.expression:
    """Parse, whitelist-check, and return the tree. Everything else raises."""
    if not formula or not formula.strip():
        raise ExprError("formula is empty")
    src = formula.replace("×", "*").replace("÷", "/").replace("−", "-")
    try:
        tree = ast.parse(src, mode="eval")
    except SyntaxError as exc:
        raise ExprError(f"formula does not parse: {exc.msg}") from exc
    _check(tree.body)
    return tree


def _check(node: ast.AST) -> None:
    if isinstance(node, ast.BinOp):
        if type(node.op) not in _BINOPS:
            raise ExprError(f"operator `{type(node.op).__name__}` is not in the language")
        _check(node.left)
        _check(node.right)
        return
    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, (ast.USub, ast.UAdd)):
            raise ExprError(f"unary `{type(node.op).__name__}` is not in the language")
        _check(node.operand)
        return
    if isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float)) or isinstance(node.value, bool):
            raise ExprError(f"literal `{node.value!r}` is not a number")
        return
    if isinstance(node, ast.Name):
        return
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
            raise ExprError(
                f"only {', '.join(_FUNCS)} may be called; "
                f"`{ast.dump(node.func)[:60]}` may not"
            )
        if node.keywords:
            raise ExprError("keyword arguments are not in the language")
        if len(node.args) != 1:
            raise ExprError(f"{node.func.id}() takes exactly one argument")
        _check(node.args[0])
        return
    raise ExprError(f"`{type(node).__name__}` is not in the language")


def names(tree: ast.expression) -> set[str]:
    """The free input names the formula uses (function names excluded)."""
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            out.add(node.id)
    return out - set(_FUNCS)


# ── Dimension inference (registration time) ──────────────────────────────────


def infer(tree: ast.expression, input_qty: dict[str, Qty]) -> Qty:
    """The quantity the formula produces, or a DimensionError saying why not."""
    return _infer(tree.body, input_qty)


def _infer(node: ast.AST, env: dict[str, Qty]) -> Qty:
    if isinstance(node, ast.BinOp):
        op = _BINOPS[type(node.op)]
        left = _infer(node.left, env)
        right = _infer(node.right, env)
        if op in ("+", "-"):
            return add_sub(op, left, right)
        return mul_div(op, left, right)
    if isinstance(node, ast.UnaryOp):
        return _infer(node.operand, env)
    if isinstance(node, ast.Constant):
        return DIMENSIONLESS
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise DimensionError(f"formula names `{node.id}`, which is not a declared input")
        return env[node.id]
    if isinstance(node, ast.Call):
        # abs and annualize both preserve the quantity (dimensionless scaling).
        return _infer(node.args[0], env)
    raise ExprError(f"`{type(node).__name__}` is not in the language")  # unreachable after _check


# ── Arithmetic (evaluation time) ─────────────────────────────────────────────


def evaluate(tree: ast.expression, env: dict[str, float], *, window_days: float | None = None) -> float:
    return _eval(tree.body, env, window_days)


def _eval(node: ast.AST, env: dict[str, float], window_days: float | None) -> float:
    if isinstance(node, ast.BinOp):
        op = _BINOPS[type(node.op)]
        left = _eval(node.left, env, window_days)
        right = _eval(node.right, env, window_days)
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if right == 0:
            raise EvalRefusal("blocked", "division by zero — the divisor evaluated to 0")
        return left / right
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, env, window_days)
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, ast.Constant):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise EvalRefusal("blocked", f"input `{node.id}` has no value")
        return env[node.id]
    if isinstance(node, ast.Call):
        v = _eval(node.args[0], env, window_days)
        if node.func.id == "abs":  # type: ignore[union-attr]
            return abs(v)
        # annualize
        if not window_days or window_days <= 0:
            raise EvalRefusal("blocked", "annualize() needs a window with nonzero length")
        return v * (365.0 / window_days)
    raise EvalRefusal("blocked", f"`{type(node).__name__}` is not in the language")


def render(tree: ast.expression, env: dict[str, float]) -> str:
    """The formula with the numbers substituted — the auditable working."""

    def r(node: ast.AST) -> str:
        if isinstance(node, ast.BinOp):
            op = _BINOPS[type(node.op)]
            sym = {"+": "+", "-": "−", "*": "×", "/": "÷"}[op]
            return f"({r(node.left)} {sym} {r(node.right)})"
        if isinstance(node, ast.UnaryOp):
            return f"-{r(node.operand)}" if isinstance(node.op, ast.USub) else r(node.operand)
        if isinstance(node, ast.Constant):
            return repr(node.value)
        if isinstance(node, ast.Name):
            v = env.get(node.id)
            return "?" if v is None else f"{v:g}"
        if isinstance(node, ast.Call):
            return f"{node.func.id}({r(node.args[0])})"  # type: ignore[union-attr]
        return "?"

    s = r(tree.body)
    # strip one redundant outer paren pair for readability
    return s[1:-1] if s.startswith("(") and s.endswith(")") else s
