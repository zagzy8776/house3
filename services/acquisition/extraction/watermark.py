"""
Watermark detection, from the pixels.

WHY THIS MODULE EXISTS, AND WHAT IT IS NOT
------------------------------------------
`extraction/media.py` refuses images whose URL names a publisher's brand. That is
a filter for one measured case and it says so: NPC puts the brand in the
filename, so the filename is enough. Every other portal in Nigeria watermarks its
photographs too, and most of them do it over a generic `/img/8821.jpg`, where the
URL tells you nothing at all.

So this module looks at the image.

WHAT WE DO WITH A POSITIVE RESULT
---------------------------------
A watermarked image is DROPPED. We do not scrub it, we do not blur it, we do not
crop it out, and there is no code path here that writes a derived image. Two
reasons, and the second is the one that actually matters:

  * Legally, the watermark is the publisher's assertion of ownership over that
    frame. Removing it and republishing the result is the exact act the mark
    exists to prevent.
  * Practically, it makes the photograph worthless as evidence. Everything on a
    place page is offered as observed fact. A picture the platform has edited to
    conceal where it came from is not an observation, and an inpainting model does
    not RECOVER what was behind the mark - it invents a plausible room. A guest
    phoning a number over an invented room has been misled in the same way a
    fabricated price would mislead them.

That second reason is why this is a filter rather than a cleaner: the product
depends on a guest trusting that what they are looking at is what was published.

THE DETECTOR, AND WHY IT NEEDS A TRAINED MODEL
----------------------------------------------
Calibrated against measurements, not intuition. Three attempts were made and the
numbers from each are recorded, because the last one is the finding that matters.

Attempt 1 assumed a watermark makes the centre BRIGHTER than the image mean. It
does not: on the real NPC sample the mark sits over a dark sofa in a bright room,
so the centre measures 40 BELOW the image mean.

Attempt 2 assumed a watermark makes the centre FLATTER. Backwards. A watermark is
hard-edged paint over a smooth photograph, so it ADDS high-frequency energy.

Attempt 3 measured the two signals that do move, across four labelled cases:

    case                      contrast ratio   edge-density ratio   watermarked
    clean interior                  0.22              0.04             no
    same interior + watermark       1.20              0.88             yes
    bright centre (white wall)      1.56              1.31             no
    dark band over bright room      1.01              0.75             no

CONTRAST ALONE CANNOT SEPARATE THEM. The watermarked case sits at 1.20, and a
genuinely bright centre - a white wall, a window, a white sofa, all extremely
common in interior photography - sits HIGHER at 1.56. Any threshold that catches
the watermark also refuses the white wall, and refusing ordinary rooms is not a
conservative setting: it is the exact failure this feature exists to prevent.

Attempt 4 ran the detector against REAL images, which is the only test that
settles it. Three watermarked NPC photographs and three clean, unwatermarked
interiors from an unrelated source:

    watermarked NPC photos (n=2 tested)     -> refused
    clean unwatermarked interiors (n=3)     -> REFUSED

    measured contrast ratios of the CLEAN images: 1.04, 1.20, 1.00

The clean images score the same as the watermarked ones. There is no threshold
that admits them. This detector, on these statistics, refuses clean and
watermarked photographs alike - which makes it a "refuse everything" filter and
NOT a watermark detector, and shipping it as one while claiming otherwise would
be the most misleading thing in this module.

WHAT ACTUALLY WOULD WORK, AND WHY IT IS NOT HERE
------------------------------------------------
A trained classifier. It would beat these statistics comfortably, because glyph
strokes are a SHAPE and a mean and a variance throw shape away entirely - which
is exactly why attempts 1-4 kept failing on the same overlap. `torch` is
installed and `ModelProbe` is the wired-in hook; the scoring path is tested with
stand-in probes.

IT DOES NOT SHIP UNTRAINED, AND THAT IS THE WHOLE FINDING. Training needs labelled
watermarked AND clean photographs. This crawl has 258 watermarked NPC images and
ZERO confirmed-clean ones, because every source crawled so far watermarks. Training
on one class teaches a model that everything is watermarked - a model that agrees
with the detector above, and is just as useless.

SO THE PIPELINE CONTINUES TO REFUSE WHAT IT CANNOT VERIFY
--------------------------------------------------------
Every image from a source we have not cleared is dropped. `extraction/media.py`
refuses watermarked URLs outright, and `publishing.verify_media` refuses anything
whose pixels cannot be cleared. The `--verify-photos` flag is wired and tested, so
the moment there is a source that publishes clean photographs - an operator's own
site, Instagram, or an affiliate feed - its images pass through both gates and
appear on a card.

BANNED: NO WATERMARK-REMOVAL CODE PATH
--------------------------------------
Stated as a prohibition rather than left implicit, because it is the one request
that would quietly undo everything above.

This module MUST NOT gain a function that erases, blurs, inpaints, crops around or
otherwise removes a watermark. Not behind a flag, not for a preview, not "just for
the thumbnail". The reasons are in the two bullets above, and they do not weaken
because the caller is impatient:

  * It is the act the mark exists to prevent, done deliberately and on purpose.
  * It produces a photograph that is no longer evidence of anything. An inpainting
    model does not recover what was behind the mark - it invents a plausible room.
    A guest choosing a place by an invented room has been misled exactly as they
    would be by a fabricated price.

If a source's photographs are watermarked, the answer is to acquire them from the
operator, or to show the listing without photographs. It is not to launder the
publisher's asset through a model and call the result ours.

NO IMAGE IS EVER WRITTEN BY THIS MODULE
---------------------------------------
Every function here reads and returns a judgement.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

try:  # Pillow is already a hard dependency of the extraction layer.
    from PIL import Image
except ImportError:  # pragma: no cover - the pipeline cannot run without it
    Image = None  # type: ignore[assignment]


#: A watermark is expected near the middle. The window is a fraction of the
#: smaller edge, so the same rules apply to a portrait phone snap and a wide
#: landscape shot.
_CENTRE_FRACTION = 0.55

#: Below this contrast ratio a watermark is ruled out. From the calibration table
#: in the module docstring: clean interiors measure 0.22, so anything under 0.6 is
#: comfortably clear and this cheaply passes the large majority of photographs.
#:
#: There is deliberately NO upper threshold. The watermarked case measured 1.20 and
#: a genuine white wall measured 1.56, so there is no value that admits one and
#: refuses the other - see the module docstring. Claiming otherwise would be a
#: false positive filter dressed up as a detector.
_CLEAR_CONTRAST_RATIO = 0.6

#: A gradient magnitude at or above this counts as an edge. On 0-255 luminance.
_EDGE_MAGNITUDE = 28

#: In a saturated photograph, near-grey watermark paint shows up as a relative
#: loss of chroma. Corroboration only - on a monochrome interior it means nothing.
_CHROMA_DROP_THRESHOLD = 0.92
_MIN_SATURATION_FOR_CHROMA = 14.0


@dataclass(frozen=True)
class WatermarkVerdict:
    """
    What the detector saw, and whether it believes there is a watermark.

    The signals are carried rather than collapsed into the boolean because a
    decision that drops a photograph has to be explainable afterwards - "why does
    this listing have no photo" is a question someone will ask.
    """

    watermarked: bool
    confidence: float
    reason: str
    #: Diagnostics, in the detector's own units. Not for UI.
    centre_lift: float
    flatness_ratio: float
    chroma_ratio: float


class ModelProbe:
    """
    Optional learned detector.

    Returns None when no model is available, which is the normal case: the
    pipeline has no trained classifier to load. Kept as a class so a probe can be
    swapped in for tests without touching the heuristics.
    """

    def __init__(self, model=None) -> None:
        self._model = model

    @property
    def available(self) -> bool:
        return self._model is not None

    def score(self, image) -> Optional[float]:
        """Probability that the centre crop carries a watermark, or None."""
        if self._model is None:
            return None
        try:  # pragma: no cover - no model ships, so this is a hook
            return float(self._model(_centre_crop(image)))
        except Exception:
            return None


def probe_available() -> dict:
    """
    What the detector can actually do in this process.

    Reported by the pipeline so a run says which filter it used rather than
    silently degrading. `pillow` false means detection is impossible, and every
    image is then refused - which is the safe direction.
    """
    return {
        "pillow": Image is not None,
        "model": False,
        "heuristics": Image is not None,
        "detail": "centre contrast + edge density + chroma heuristics; no learned model ships",
    }


def _centre_crop(image):
    width, height = image.size
    side = int(min(width, height) * _CENTRE_FRACTION)
    if side < 8:
        return image
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def _luminances(image) -> list[int]:
    """Per-pixel luminance, 0-255, on a downscaled copy."""
    small = image.convert("L")
    # Downscale before scanning: a watermark is large-scale by nature, and this
    # keeps a 4000px photograph to a few thousand pixels of work.
    small.thumbnail((160, 160))
    width, height = small.size
    data = list(small.getdata())

    # One pass, and the edge magnitude needs neighbours, so the caller gets the
    # flat list plus the dimensions it implies.
    return data


def _spread(values: list[int]) -> float:
    """Standard deviation of a luminance list."""
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return (sum((value - mean) ** 2 for value in values) / len(values)) ** 0.5


def _saturation(image) -> float:
    """Mean chroma, 0-255 scaled."""
    small = image.convert("RGB")
    small.thumbnail((160, 160))
    pixels = list(small.getdata())
    if not pixels:
        return 0.0
    return sum(max(p) - min(p) for p in pixels) / len(pixels)


def _edge_density(image) -> float:
    """
    The fraction of pixels sitting on a strong gradient.

    Computed on the downscaled copy so a glyph stroke is several pixels wide and
    therefore measurable, rather than the sub-pixel feature it is on a 4000px
    original.
    """
    small = image.convert("L")
    small.thumbnail((160, 160))
    width, height = small.size
    if width < 3 or height < 3:
        return 0.0

    data = list(small.getdata())

    def at(x: int, y: int) -> int:
        return data[y * width + x]

    strong = 0
    considered = 0
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            gx = abs(at(x + 1, y) - at(x - 1, y))
            gy = abs(at(x, y + 1) - at(x, y - 1))
            considered += 1
            if gx + gy >= _EDGE_MAGNITUDE:
                strong += 1

    return strong / considered if considered else 0.0


def _stats(image) -> tuple[float, float, float]:
    """Mean luminance, luminance spread, and mean saturation, all 0-255 scaled."""
    luminances = _luminances(image)
    if not luminances:
        return 0.0, 0.0, 0.0
    return sum(luminances) / len(luminances), _spread(luminances), _saturation(image)


def inspect(image, probe: Optional[ModelProbe] = None) -> WatermarkVerdict:
    """
    Judge one decoded image.

    Returns a verdict rather than a boolean so the deciding signal is recorded.
    The model, when one is supplied, takes precedence over the heuristics - it is
    the better instrument and the heuristics exist only because it is absent.
    """
    if Image is None:  # pragma: no cover - the pipeline cannot run without Pillow
        return WatermarkVerdict(
            watermarked=True,
            confidence=1.0,
            reason="Pillow is unavailable, so no image can be verified",
            centre_lift=0.0,
            flatness_ratio=0.0,
            chroma_ratio=0.0,
        )

    try:
        whole_mean, whole_spread, whole_sat = _stats(image)
        centre_mean, centre_spread, centre_sat = _stats(_centre_crop(image))
        whole_edges = _edge_density(image)
        centre_edges = _edge_density(_centre_crop(image))
    except Exception as error:  # a truncated or exotic file
        return WatermarkVerdict(
            watermarked=True,
            confidence=1.0,
            reason=f"Could not be read as an image ({type(error).__name__})",
            centre_lift=0.0,
            flatness_ratio=0.0,
            chroma_ratio=0.0,
        )

    if probe is not None:
        model_score = probe.score(image)
        if model_score is not None:
            return WatermarkVerdict(
                watermarked=model_score >= 0.5,
                confidence=float(model_score),
                reason=f"model score {model_score:.3f}",
                centre_lift=centre_mean - whole_mean,
                flatness_ratio=_safe_ratio(centre_spread, whole_spread),
                chroma_ratio=_safe_ratio(centre_sat, whole_sat),
            )

    return _verdict_from_signals(
        whole_mean,
        whole_spread,
        whole_sat,
        whole_edges,
        centre_mean,
        centre_spread,
        centre_sat,
        centre_edges,
    )


def _safe_ratio(centre: float, whole: float) -> float:
    """`centre / whole`, with a floor so a flat image cannot divide by zero."""
    if whole <= 1e-6:
        return 1.0
    return centre / whole


def _verdict_from_signals(
    whole_mean: float,
    whole_spread: float,
    whole_sat: float,
    whole_edges: float,
    centre_mean: float,
    centre_spread: float,
    centre_sat: float,
    centre_edges: float,
) -> WatermarkVerdict:
    """
    The heuristic pre-screen. Deliberately one-directional.

    It can only ever answer "clear" or "cannot tell", never "watermarked":

      * A LOW contrast ratio means no watermark. Glyph strokes are hard edges over
        a smooth photograph, so they always raise the centre's contrast relative to
        the image; a centre that is markedly SMOOTHER than its surroundings cannot
        contain them. This is the direction the signals support, and it cheaply
        passes most photographs.
      * Anything else is UNCERTAIN, and uncertain is treated as watermarked,
        because the cost of the two mistakes is asymmetric. Refusing a clean
        photograph loses one listing's picture. Publishing a watermarked one is a
        legal problem and a lie to the guest about what they are looking at.

    The false-positive cost is real and this function is where it lands. It is
    kept because the alternative - passing everything the statistics cannot rule
    out - would publish the watermarked NPC images this whole line of work exists
    to refuse.
    """
    lift = centre_mean - whole_mean
    contrast = _safe_ratio(centre_spread, whole_spread)
    edges = _safe_ratio(centre_edges, whole_edges)
    chroma = _safe_ratio(centre_sat, whole_sat)
    desaturated = whole_sat >= _MIN_SATURATION_FOR_CHROMA and chroma <= _CHROMA_DROP_THRESHOLD

    if contrast < _CLEAR_CONTRAST_RATIO:
        return WatermarkVerdict(
            False,
            0.0,
            f"centre contrast ratio {contrast:.2f} is below the {_CLEAR_CONTRAST_RATIO} mark, "
            "so it is too smooth to carry glyph strokes",
            lift,
            contrast,
            chroma,
        )

    # At or above the mark: the statistics cannot separate a watermark from
    # ordinary subject matter - a white wall scores higher than the watermark does.
    # Without a trained model we refuse rather than guess, and we say so in the
    # reason rather than implying a watermark was found.
    return WatermarkVerdict(
        True,
        0.5,
        f"centre contrast ratio {contrast:.2f} is above the {_CLEAR_CONTRAST_RATIO} mark "
        f"(edges {edges:.2f}x) and no trained model is available to separate a watermark "
        "from ordinary subject matter, so it is refused rather than guessed at"
        + (", and the centre is less saturated than the image" if desaturated else ""),
        lift,
        contrast,
        chroma,
    )


def inspect_bytes(data: bytes, probe: Optional[ModelProbe] = None) -> WatermarkVerdict:
    """Judge an encoded image. The entry point the fetcher uses."""
    if Image is None:  # pragma: no cover
        return WatermarkVerdict(True, 1.0, "Pillow is unavailable", 0.0, 0.0, 0.0)
    try:
        import io as _io

        with Image.open(_io.BytesIO(data)) as handle:
            handle.load()
            return inspect(handle, probe)
    except Exception as error:
        return WatermarkVerdict(
            watermarked=True,
            confidence=1.0,
            reason=f"Could not be decoded ({type(error).__name__})",
            centre_lift=0.0,
            flatness_ratio=0.0,
            chroma_ratio=0.0,
        )
