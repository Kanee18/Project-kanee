"""Unit tests for the incremental sentence/tag parser (Milestone 1).

Covers the happy path, chunk boundaries inside tags, and every malformed-input
rule from CLAUDE.md: unknown tags, missing tags, interjections, ellipses,
literal brackets, and truncated streams. The parser must never crash.
"""

import logging

import pytest

from parser import Segment, StreamingTagParser

EXAMPLE = (
    "[excited][bounce] Oh my gosh, you're back! "
    "[happy][wave] I was just thinking about you. "
    "[curious][lean_in] So? How did the exam go?"
)

EXAMPLE_SEGMENTS = [
    Segment("excited", "bounce", "Oh my gosh, you're back!"),
    Segment("happy", "wave", "I was just thinking about you."),
    Segment("curious", "lean_in", "So? How did the exam go?"),
]


def run(text: str, chunk_size: int | None = None) -> list[Segment]:
    """Feed text (optionally in fixed-size chunks) and return all segments."""
    p = StreamingTagParser()
    segments: list[Segment] = []
    if chunk_size is None:
        segments += p.feed(text)
    else:
        for i in range(0, len(text), chunk_size):
            segments += p.feed(text[i : i + chunk_size])
    segments += p.finish()
    return segments


# -- happy path --------------------------------------------------------------


def test_canonical_example_single_chunk():
    assert run(EXAMPLE) == EXAMPLE_SEGMENTS


@pytest.mark.parametrize("chunk_size", [1, 2, 3, 5, 7, 17])
def test_canonical_example_arbitrary_chunking(chunk_size):
    assert run(EXAMPLE, chunk_size) == EXAMPLE_SEGMENTS


def test_segments_emit_before_stream_ends():
    """A segment must be emitted as soon as the NEXT tag arrives, not at finish()."""
    p = StreamingTagParser()
    segs = p.feed("[excited] You're back! [happy] I missed")
    assert [s.text for s in segs] == ["You're back!"]
    segs = p.feed(" you. [curious] Really?")
    assert [s.text for s in segs] == ["I missed you."]
    assert [s.text for s in p.finish()] == ["Really?"]


def test_split_mid_tag():
    p = StreamingTagParser()
    segs = []
    for chunk in ["[exc", "ited][bou", "nce] Yay!"]:
        segs += p.feed(chunk)
    segs += p.finish()
    assert segs == [Segment("excited", "bounce", "Yay!")]


def test_multi_sentence_under_one_tag_is_one_segment():
    segs = run("[happy] I missed you. It's been so long! [neutral] Anyway.")
    assert segs == [
        Segment("happy", None, "I missed you. It's been so long!"),
        Segment("neutral", None, "Anyway."),
    ]


def test_exclamation_question_runs():
    segs = run("[excited] No way?! [surprised] Wait!! [neutral] Okay.")
    assert segs == [
        Segment("excited", None, "No way?!"),
        Segment("surprised", None, "Wait!!"),
        Segment("neutral", None, "Okay."),
    ]


def test_whitespace_and_newlines_normalized():
    segs = run("[happy] Hello,\n   friend!")
    assert segs == [Segment("happy", None, "Hello, friend!")]


# -- interjections and ellipses ------------------------------------------------


def test_interjection_without_terminal_attaches_forward():
    segs = run("[curious] Hmm, [happy] yes!")
    assert segs == [Segment("happy", None, "Hmm, yes!")]


def test_trailing_ellipsis_attaches_forward():
    segs = run("[neutral] Well... [happy][nod] okay then!")
    assert segs == [Segment("happy", "nod", "Well... okay then!")]


def test_unicode_ellipsis_attaches_forward():
    segs = run("[neutral] Well… [happy] sure!")
    assert segs == [Segment("happy", None, "Well… sure!")]


# -- malformed input: must degrade gracefully, never crash ---------------------


def test_unknown_emotion_falls_back_to_neutral(caplog):
    with caplog.at_level(logging.WARNING):
        segs = run("[joyful] Hi!")
    assert segs == [Segment("neutral", None, "Hi!")]
    assert any("joyful" in r.getMessage() for r in caplog.records)


def test_unknown_gesture_is_dropped(caplog):
    with caplog.at_level(logging.WARNING):
        segs = run("[happy][backflip] Hi!")
    assert segs == [Segment("happy", None, "Hi!")]
    assert any("backflip" in r.getMessage() for r in caplog.records)


def test_missing_leading_tag_defaults_to_neutral(caplog):
    with caplog.at_level(logging.WARNING):
        segs = run("Hello there!")
    assert segs == [Segment("neutral", None, "Hello there!")]


def test_gesture_only_tag_gets_neutral_emotion():
    segs = run("[wave] Hi!")
    assert segs == [Segment("neutral", "wave", "Hi!")]


def test_duplicate_emotion_last_wins():
    segs = run("[happy][excited] Woo!")
    assert segs == [Segment("excited", None, "Woo!")]


def test_bracketed_non_tag_content_stays_in_text():
    segs = run("[happy] I scored [over 9000] points!")
    assert segs == [Segment("happy", None, "I scored [over 9000] points!")]


def test_unknown_single_word_bracket_midtext_is_stripped():
    segs = run("[happy] Check the config[s] file.")
    assert segs == [Segment("happy", None, "Check the config file.")]


def test_no_terminal_punctuation_at_end_of_stream_still_emits():
    segs = run("[happy] See you later")
    assert segs == [Segment("happy", None, "See you later")]


def test_stream_ends_mid_tag_drops_partial(caplog):
    with caplog.at_level(logging.WARNING):
        segs = run("[happy] Hi! [cur")
    assert segs == [Segment("happy", None, "Hi!")]
    assert any("mid-tag" in r.getMessage() for r in caplog.records)


def test_tags_only_no_text_yields_nothing():
    assert run("[happy][wave]") == []


def test_empty_stream():
    assert run("") == []


def test_garbage_never_crashes():
    garbage = "]]][[[ ]] [!!] [] te[xt. More?? [[nested [happy] ok!] done... [123]"
    segs = run(garbage, chunk_size=3)
    for seg in segs:
        assert seg.emotion in {
            "neutral", "happy", "excited", "sad", "angry",
            "surprised", "shy", "pout", "curious", "smug",
        }
        assert seg.text
