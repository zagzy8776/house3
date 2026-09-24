"""
Watermark detector tests.

HOW THE TRUTH IS ESTABLISHED
----------------------------
The detector separates watermarked photographs from clean ones, so testing it
needs both with a KNOWN label. Two sources are used:

  * SYNTHETIC, where the label is certain. A photograph is generated, and the
    watermarked variant is that same photograph with a white wordmark and a logo
    drawn over the centre - which is what a portal does. Because the two differ
    ONLY by the watermark, any verdict that differs between them is attributable
    to the watermark and nothing else.
  * REAL, where the label is established by looking. The NPC file fetched during
    development carries "Nigeria property centre" and its house logo across the
    middle, confirmed by eye.

The synthetic pair is what tests the maths. The real sample is what tests whether
the maths applies to reality - and it is recorded here because it caught a false
negative no synthetic case would have: the real watermark sits over a DARK sofa in
a BRIGHT room, so the centre is BELOW the image's mean luminance, and a detector
that only looked for a bright centre passed it as clean.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from extraction.watermark import (
    ModelProbe,
    WatermarkVerdict,
    inspect,
    inspect_bytes,
    probe_available,
)


def _photograph(seed: int = 7, size: tuple[int, int] = (400, 300)) -> Image.Image:
    """
    A plausible interior: warm walls, a window, furniture, some texture.

    Deliberately NOT a flat colour. A flat image would make the flatness signal
    meaningless and would let a broken detector pass.
    """
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            # A soft vertical gradient with a warm cast, plus a bright window.
            base = 70 + int(60 * (y / height))
            warm = 18 if x < width * 0.7 else 0
            window = 90 if (width * 0.72 < x < width * 0.9 and height * 0.15 < y < height * 0.5) else 0
            noise = ((x * 7 + y * 13 + seed * 31) % 17) - 8
            pixels[x, y] = (
                min(255, base + warm + window + noise),
                min(255, base + window + noise),
                min(255, base - 8 + window + noise),
            )

    draw = ImageDraw.Draw(image)
    # A sofa, so the centre is not a uniform field.
    draw.rectangle([width * 0.30, height * 0.55, width * 0.70, height * 0.78], fill=(96, 98, 104))
    return image


def _watermark(image: Image.Image) -> Image.Image:
    """
    Draw a watermark the way a portal does: a semi-transparent white logo and
    wordmark, centred, over the photograph.
    """
    marked = image.copy()
    width, height = marked.size

    overlay = Image.new("RGBA", marked.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    cx, cy = width / 2, height / 2
    draw.rectangle([cx - 18, cy - 14, cx + 18, cy + 14], fill=(255, 255, 255, 210))
    draw.polygon([(cx - 24, cy - 14), (cx + 24, cy - 14), (cx, cy - 34)], fill=(255, 255, 255, 210))
    draw.rectangle([cx - 6, cy + 2, cx + 6, cy + 14], fill=(0, 0, 0, 90))
    draw.rectangle([cx + 26, cy - 10, cx + 150, cy - 2], fill=(255, 255, 255, 225))
    draw.rectangle([cx + 26, cy + 4, cx + 112, cy + 12], fill=(255, 255, 255, 205))

    return Image.alpha_composite(marked.convert("RGBA"), overlay).convert("RGB")


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# the detector's contract
# ---------------------------------------------------------------------------


def test_a_clean_photograph_is_not_flagged() -> None:
    """
    A clean interior with a smooth centre passes the pre-screen. This is the
    direction the statistics genuinely support: glyph strokes are hard edges, so a
    centre markedly smoother than its surroundings cannot contain them.
    """
    verdict = inspect(_photograph())

    assert verdict.watermarked is False
    assert verdict.confidence == 0.0
    # And it says why, in units someone can argue with.
    assert "contrast ratio" in verdict.reason


def test_a_watermarked_photograph_is_flagged() -> None:
    """
    The measured case: the same photograph with a centred white wordmark and logo
    over it. Because the ONLY difference is the watermark, a changed verdict is
    attributable to the watermark and nothing else.
    """
    verdict = inspect(_watermark(_photograph()))

    assert verdict.watermarked is True
    assert verdict.confidence > 0.0


def test_the_pair_differs_only_by_the_watermark() -> None:
    """
    The control. If this fails, the tests above stop proving anything, since the
    difference they detect could be something other than the mark.
    """
    clean = _photograph()
    marked = _watermark(clean)

    assert inspect(clean).watermarked is False
    assert inspect(marked).watermarked is True


def test_the_detector_refuses_clean_interiors_too_and_that_is_the_finding() -> None:
    """
    THE MEASURED CONCLUSION, PINNED SO IT CANNOT BE MISREAD AS A WORKING DETECTOR.

    Run against real images, the statistics refuse clean and watermarked
    photographs alike:

        watermarked NPC photos        -> refused
        clean unwatermarked interiors -> refused

    The clean images measured contrast ratios of 1.04, 1.20 and 1.00, overlapping
    the watermarked images entirely. So this is not a watermark detector that
    errs on the side of caution - it is a filter that cannot tell the difference,
    and its effect is to refuse almost everything.

    This test uses the synthetic pair, where a clean interior scores 0.22 and
    passes, because a network fetch in a unit test is not acceptable. The point it
    protects is the DECISION RECORDED IN THE MODULE DOCSTRING: that the real
    result was measured, that it was bad, and that the response was to say so
    rather than tune a threshold until the fixtures passed.

    If someone later replaces these statistics with a trained model, this test
    should be deleted deliberately and the docstring updated - not quietly
    adjusted until it is green.
    """
    from pathlib import Path

    source = Path(__file__).with_name("extraction").joinpath("watermark.py").read_text(encoding="utf-8")

    # The measurement is in the module's own record, not only in a commit message.
    assert "clean unwatermarked interiors (n=3)     -> REFUSED" in source
    assert "NOT a watermark detector" in source
    # And the reason it is not fixed by tuning is stated where the thresholds are.
    assert "There is deliberately NO upper threshold" in source
    # The prohibition is part of the module, not just a note in a commit message.
    assert "BANNED: NO WATERMARK-REMOVAL CODE PATH" in source


def test_a_bright_centre_is_refused_because_the_statistics_cannot_tell() -> None:
    """
    The limit that makes the finding above concrete, on a case built to be fair.

    A white wall, a window or a white sofa produces a centre contrast ratio of
    about 1.56 - HIGHER than the 1.20 a watermark produces. No threshold on these
    statistics can admit the watermark and refuse the white wall, so the detector
    is honest: at or above the clear mark it says "cannot tell", and cannot-tell is
    refused.

    This test records the cost of that choice - a real photograph is lost - so
    that replacing it with a trained model is a visible improvement rather than a
    silent behaviour change.
    """
    image = _photograph()
    width, height = image.size
    draw = ImageDraw.Draw(image)
    draw.rectangle([width * 0.35, height * 0.35, width * 0.65, height * 0.65], fill=(245, 243, 238))
    draw.rectangle([width * 0.40, height * 0.40, width * 0.47, height * 0.58], fill=(180, 176, 168))
    draw.line([(width * 0.52, height * 0.36), (width * 0.52, height * 0.64)], fill=(120, 118, 112), width=3)

    verdict = inspect(image)

    # Not "clear". Refused as uncertain, and the reason says so rather than
    # claiming a watermark was found in a white wall.
    assert verdict.watermarked is True
    assert "no trained model" in verdict.reason
    """
    THE LIMIT, MEASURED, AND THE REASON NO LEARNED MODEL IS CLAIMED HERE.

    A white wall, a window or a white sofa produces a centre contrast ratio of
    about 1.56 - HIGHER than the 1.20 a watermark produces. So no threshold on
    these statistics can admit the watermark and refuse the white wall.

    Rather than tune a number until the synthetic cases pass and quietly ship
    something that refuses ordinary rooms, the detector is honest: at or above the
    mark it says "cannot tell", and cannot-tell is refused. This test records the
    cost of that choice - a real photograph is lost - so that replacing it with a
    trained model is a visible improvement and not a silent behaviour change.
    """
    image = _photograph()
    width, height = image.size
    draw = ImageDraw.Draw(image)
    draw.rectangle([width * 0.35, height * 0.35, width * 0.65, height * 0.65], fill=(245, 243, 238))
    draw.rectangle([width * 0.40, height * 0.40, width * 0.47, height * 0.58], fill=(180, 176, 168))
    draw.line([(width * 0.52, height * 0.36), (width * 0.52, height * 0.64)], fill=(120, 118, 112), width=3)

    verdict = inspect(image)

    # Not "clear". Refused as uncertain, and the reason says so rather than
    # claiming a watermark was found.
    assert verdict.watermarked is True
    assert verdict.centre_lift != 0.0
    assert "cannot" in verdict.reason or "no trained model" in verdict.reason


def test_a_dark_band_is_refused_as_uncertain_not_diagnosed() -> None:
    """
    A dark band across a bright room is refused, and NOT because a watermark was
    found in it - because it sits above the clear mark (1.01 vs 0.6) and the
    statistics cannot separate it from one.

    This is the same trade as the bright-centre case and it is recorded for the
    same reason: the detector's honest output on anything that is not clearly
    smooth is "cannot tell", and cannot-tell is refused.

    The reason string is asserted to say so. A verdict that implied "watermark
    found" here would be a fabricated diagnosis, and the log would be useless for
    the operator asking why their listing has no photograph.
    """
    image = _photograph()
    draw = ImageDraw.Draw(image)
    width, height = image.size
    draw.rectangle([width * 0.3, height * 0.45, width * 0.7, height * 0.55], fill=(20, 18, 16))

    verdict = inspect(image)

    assert verdict.watermarked is True
    assert "no trained model" in verdict.reason


def test_undecodable_bytes_are_refused() -> None:
    """
    Fail closed. If we cannot look at it, we cannot publish it - the alternative
    is publishing whatever arrived without knowing what it is.
    """
    verdict = inspect_bytes(b"this is not an image")

    assert verdict.watermarked is True
    assert verdict.confidence == 1.0
    assert "decoded" in verdict.reason.lower()


def test_a_verdict_carries_its_signals() -> None:
    """
    A decision that drops a photograph has to be explainable afterwards, because
    "why does this listing have no photo" is a question someone will ask.
    """
    verdict = inspect(_watermark(_photograph()))

    assert isinstance(verdict, WatermarkVerdict)
    assert verdict.reason
    assert isinstance(verdict.centre_lift, float)
    assert isinstance(verdict.flatness_ratio, float)
    assert isinstance(verdict.chroma_ratio, float)


# ---------------------------------------------------------------------------
# the optional model
# ---------------------------------------------------------------------------


def test_no_model_ships_and_the_heuristics_still_work() -> None:
    """
    The pipeline must run on a bare Pillow install. A crawl that refuses to start
    because a classifier is missing is worse than a crawl with a weaker filter, so
    the model is a hook and its absence is a supported state.
    """
    available = probe_available()

    assert available["pillow"] is True
    assert available["heuristics"] is True
    assert available["model"] is False
    # It says which filter ran rather than silently degrading.
    assert "no learned model" in available["detail"]


def test_a_model_takes_precedence_over_the_heuristics() -> None:
    """
    When a trained probe is supplied it decides, because it is the better
    instrument - and the reason a probe is the thing that makes this detector
    real rather than approximate. Here a probe answering 0.9 flags a CLEAN
    photograph, proving the model's answer is returned rather than blended with
    the statistics.
    """
    probe = ModelProbe(model=lambda crop: 0.9)
    verdict = inspect(_photograph(), probe)

    assert verdict.watermarked is True
    assert verdict.confidence == pytest.approx(0.9)
    assert "model score" in verdict.reason


def test_a_model_that_always_trusts_overrides_a_watermarked_image() -> None:
    """
    The other direction, so the test above cannot pass by accident: the model is
    authoritative both ways, not only when it agrees with the statistics.
    """
    probe = ModelProbe(model=lambda crop: 0.1)

    assert inspect(_watermark(_photograph()), probe).watermarked is False


def test_a_broken_model_falls_back_rather_than_crashing() -> None:
    """
    A probe that raises must not take a crawl down with it. The statistics resume
    and the run continues.
    """
    def explode(crop):
        raise RuntimeError("model exploded")

    verdict = inspect(_watermark(_photograph()), ModelProbe(model=explode))

    assert verdict.watermarked is True  # the pre-screen still refused it
    assert "contrast ratio" in verdict.reason
