"""The metric expression language — small on purpose, and never `eval`.

GRAMMAR (all of it)
-------------------
    expr    := term (('+' | '-') term)*
    term    := factor (('*' | '/') factor)*
    factor  := NUMBER | NAME | '(' expr ')' | '-' factor | FUNC '(' args ')'
    FUNC    := 'abs' | 'annualize' | 'band_score' | 'benchmark_score'

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
dimension is preserved. With no window it is a refusal. For a site-scope
consumption formula the evaluator passes the COVERED span (first to last
register bucket), not the requested window — the same definition `/bi/rating`
annualises over, so the two paths cannot disagree (contract §21).

THE NORMALIZATION FUNCTIONS (contract §21)
------------------------------------------
`band_score(x, lo, hi)` — a 0–100 score of x against a design band stated in
x's OWN unit. `lo`/`hi` must be positive numeric LITERALS with lo < hi — they
are spec parameters that live in the formula ROW, visible and versioned, not
buried constants. Shape: inside [lo, hi] → 100; below, linear 100→0 over
[0, lo]; above, linear 100→0 over [hi, 2·hi]; negative x scores 0 (pass
`abs(x)` when the sign is conventional, as a chiller ΔT's is). The result is
DIMENSIONLESS whatever x is — a score is not a temperature.

`benchmark_score(x)` — the position of x against the EFFECTIVE benchmark
standard's band edges: best-band edge → 100, worst-band edge → 0, linear
between, clamped. The edges are DATA (`benchmark_standards` + the site's zone
and AC-category config); the evaluator resolves them per site BEFORE
arithmetic and refuses — `no_benchmark`, naming exactly which input is missing
— when it cannot. At registration the argument must be `energy_per_area`, the
one dimension this platform holds benchmarks for.
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


_FUNCS = ("abs", "annualize", "band_score", "benchmark_score")

# arity per function — checked at parse, so a wrong call is a registration
# error naming itself, never a TypeError at evaluation.
_FUNC_ARITY = {"abs": 1, "annualize": 1, "benchmark_score": 1, "band_score": 3}

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
        arity = _FUNC_ARITY[node.func.id]
        if len(node.args) != arity:
            raise ExprError(
                f"{node.func.id}() takes exactly {arity} argument{'s' if arity != 1 else ''}"
            )
        if node.func.id == "band_score":
            lo, hi = _band_literals(node)
            if not (0 < lo < hi):
                raise ExprError(
                    f"band_score(x, lo, hi) needs 0 < lo < hi; got lo={lo:g}, hi={hi:g}"
                )
        for a in node.args:
            _check(a)
        return
    raise ExprError(f"`{type(node).__name__}` is not in the language")


def _band_literals(node: ast.Call) -> tuple[float, float]:
    """band_score's lo/hi must be numeric literals — spec parameters IN the
    row, where a reviewer sees them, not names resolved from anywhere."""
    vals = []
    for a in node.args[1:]:
        if not (isinstance(a, ast.Constant) and isinstance(a.value, (int, float))
                and not isinstance(a.value, bool)):
            raise ExprError("band_score(x, lo, hi): lo and hi must be numeric literals")
        vals.append(float(a.value))
    return vals[0], vals[1]


def uses(tree: ast.expression, func: str) -> bool:
    """Whether the formula calls `func` — the evaluator asks this to know what
    context it must resolve (a benchmark, a window) before arithmetic."""
    return any(
        isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == func
        for n in ast.walk(tree)
    )


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
        fn = node.func.id  # type: ignore[union-attr]
        arg = _infer(node.args[0], env)
        if fn in ("abs", "annualize"):
            # both preserve the quantity (dimensionless scaling)
            return arg
        if fn == "band_score":
            # a 0-100 score against a band in the argument's own unit
            return DIMENSIONLESS
        # benchmark_score: the one benchmark dimension this platform holds
        if arg.dimension != "energy_per_area":
            raise DimensionError(
                f"benchmark_score() grades an EPI and needs `energy_per_area`; "
                f"the argument is `{arg.dimension}`"
            )
        return DIMENSIONLESS
    raise ExprError(f"`{type(node).__name__}` is not in the language")  # unreachable after _check


# ── Arithmetic (evaluation time) ─────────────────────────────────────────────


def evaluate(
    tree: ast.expression,
    env: dict[str, float],
    *,
    window_days: float | None = None,
    benchmark: dict | None = None,
) -> float:
    """`benchmark` is the RESOLVED edge pair `{"best": .., "worst": ..}` the
    evaluator looked up for this site — or None, which makes benchmark_score a
    refusal (the evaluator normally refuses earlier, with the precise missing
    input named; this is the backstop)."""
    return _eval(tree.body, env, window_days, benchmark)


def _eval(node: ast.AST, env: dict[str, float], window_days: float | None,
          benchmark: dict | None = None) -> float:
    if isinstance(node, ast.BinOp):
        op = _BINOPS[type(node.op)]
        left = _eval(node.left, env, window_days, benchmark)
        right = _eval(node.right, env, window_days, benchmark)
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
        v = _eval(node.operand, env, window_days, benchmark)
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, ast.Constant):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise EvalRefusal("blocked", f"input `{node.id}` has no value")
        return env[node.id]
    if isinstance(node, ast.Call):
        fn = node.func.id  # type: ignore[union-attr]
        v = _eval(node.args[0], env, window_days, benchmark)
        if fn == "abs":
            return abs(v)
        if fn == "annualize":
            if not window_days or window_days <= 0:
                raise EvalRefusal("blocked", "annualize() needs a window with nonzero length")
            return v * (365.0 / window_days)
        if fn == "band_score":
            lo, hi = _band_literals(node)
            if v < 0:
                return 0.0
            if v < lo:
                return 100.0 * v / lo
            if v <= hi:
                return 100.0
            return max(0.0, 100.0 * (2.0 * hi - v) / hi)
        # benchmark_score
        if not benchmark:
            raise EvalRefusal(
                "no_benchmark",
                "benchmark_score() has no resolved benchmark for this evaluation",
            )
        best, worst = float(benchmark["best"]), float(benchmark["worst"])
        if v <= best:
            return 100.0
        if v >= worst:
            return 0.0
        return 100.0 * (worst - v) / (worst - best)
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
            args = ", ".join(r(a) for a in node.args)
            return f"{node.func.id}({args})"  # type: ignore[union-attr]
        return "?"

    s = r(tree.body)
    # strip one redundant outer paren pair for readability
    return s[1:-1] if s.startswith("(") and s.endswith(")") else s
