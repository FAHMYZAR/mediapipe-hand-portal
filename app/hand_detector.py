"""Hand detector: MediaPipe Tasks HandLandmarker plus the two-hand
framing gesture.

Model: hand_landmarker.task (MediaPipe Tasks vision), loaded from
models/hand_landmarker.task relative to the project root.

Landmark indices (21 points per hand): 0 wrist, 1-4 thumb, 5-8 index,
9-12 middle, 13-16 ring, 17-20 pinky. Tips: thumb 4, index 8,
middle 12, ring 16, pinky 20. MCPs: thumb 2, index 5, middle 9,
ring 13, pinky 17.

Framing gesture (director's viewfinder): both hands form an L with the
thumb and index finger, the two L shapes facing each other so their four
tips outline a rectangle. Detection requires both hands, index and thumb
extended on each hand, middle and ring folded, and the two wrists
separated horizontally. The frame rectangle is the bounding box of the
four thumb/index tips.
"""

import math
import os
import time

MODEL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "models", "hand_landmarker.task")


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


class HandDetector:
    """Wraps MediaPipe Tasks HandLandmarker (VIDEO running mode).

    Loads lazily so the server can still answer /api/health when the
    model is missing; /api/detect then returns 503.
    """

    def __init__(self, max_num_hands=2,
                 min_detection_confidence=0.5,
                 min_tracking_confidence=0.5):
        self.available = False
        self.error = None
        self._landmarker = None
        self._mp = None
        self._ts_ms = 0
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision
            if not os.path.exists(MODEL_PATH):
                raise FileNotFoundError("model tidak ditemukan: " + MODEL_PATH)
            self._mp = mp
            options = vision.HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=MODEL_PATH),
                running_mode=vision.RunningMode.VIDEO,
                num_hands=max_num_hands,
                min_hand_detection_confidence=min_detection_confidence,
                min_hand_presence_confidence=min_detection_confidence,
                min_tracking_confidence=min_tracking_confidence,
            )
            self._landmarker = vision.HandLandmarker.create_from_options(options)
            self.available = True
        except Exception as exc:  # noqa: BLE001 - surfaced via health/detect
            self.error = str(exc)

    def detect(self, image_bgr):
        """Run detection on one BGR frame (numpy array).

        Returns {"hands": [...], "framing": {...}, "fingers": int | None}.
        Each hand: {"label": "Left"|"Right", "landmarks": [[x, y, z], ...],
        "fingers": 0-5}. Top-level "fingers" is the count of the single
        visible hand, or None when zero or two hands are visible.
        Framing: {"detected": bool, "rect": {"x", "y", "w", "h"} | None}
        in normalized coordinates.
        """
        import cv2

        if not self.available:
            raise RuntimeError("model tidak tersedia: " + str(self.error))
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        self._ts_ms = max(self._ts_ms + 33, int(time.monotonic() * 1000))
        result = self._landmarker.detect_for_video(image, self._ts_ms)
        hands = []
        labels = []
        for handed in (result.handedness or []):
            labels.append(handed[0].category_name if handed else "Unknown")
        for i, landmarks in enumerate(result.hand_landmarks or []):
            hands.append({
                "label": labels[i] if i < len(labels) else "Unknown",
                "landmarks": [[p.x, p.y, p.z] for p in landmarks],
            })
        framing = self._detect_framing(hands)
        fingers = None
        for hand in hands:
            hand["fingers"] = self._count_fingers(hand["landmarks"])
        if len(hands) == 1:
            fingers = hands[0]["fingers"]
        return {"hands": hands, "framing": framing, "fingers": fingers}

    @classmethod
    def _count_fingers(cls, lm):
        """Count extended fingers (0-5) from 21 landmarks.

        Index/middle/ring/pinky: extended when the tip is clearly
        farther from the wrist than the MCP (same distance test as
        framing, stricter factor so a half-folded finger does not
        count). Thumb: extended when the tip sits far from the index
        MCP relative to the thumb MCP, which holds for either hand
        and any rotation.
        """
        count = 0
        for tip, mcp in ((8, 5), (12, 9), (16, 13), (20, 17)):
            if cls._finger_extended(lm, tip, mcp, 0, factor=1.25):
                count += 1
        if _dist(lm[4], lm[5]) > _dist(lm[2], lm[5]) * 1.3:
            count += 1
        return count

    @staticmethod
    def _finger_extended(lm, tip, mcp, wrist, factor=1.15):
        return _dist(lm[wrist], lm[tip]) > _dist(lm[wrist], lm[mcp]) * factor

    @classmethod
    def _is_framing_hand(cls, lm):
        index_out = cls._finger_extended(lm, 8, 5, 0)
        thumb_out = cls._finger_extended(lm, 4, 2, 0, factor=1.2)
        middle_folded = not cls._finger_extended(lm, 12, 9, 0, factor=1.35)
        ring_folded = not cls._finger_extended(lm, 16, 13, 0, factor=1.35)
        return index_out and thumb_out and middle_folded and ring_folded

    @classmethod
    def _detect_framing(cls, hands):
        """Return {"detected": bool, "rect": {...}|None}."""
        framing = {"detected": False, "rect": None}
        if len(hands) < 2:
            return framing
        framing_hands = [h for h in hands if cls._is_framing_hand(h["landmarks"])]
        if len(framing_hands) < 2:
            return framing
        framing_hands.sort(key=lambda h: h["landmarks"][0][0])
        left, right = framing_hands[0], framing_hands[1]
        if right["landmarks"][0][0] - left["landmarks"][0][0] < 0.15:
            return framing
        points = []
        for hand in (left, right):
            lm = hand["landmarks"]
            points.append((lm[4][0], lm[4][1]))  # thumb tip
            points.append((lm[8][0], lm[8][1]))  # index tip
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        if x1 - x0 < 0.1 or y1 - y0 < 0.1:
            return framing
        framing["detected"] = True
        framing["rect"] = {
            "x": max(0.0, x0), "y": max(0.0, y0),
            "w": min(1.0 - x0, x1 - x0), "h": min(1.0 - y0, y1 - y0),
        }
        return framing
