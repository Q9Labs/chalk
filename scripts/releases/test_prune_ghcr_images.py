from datetime import datetime, timedelta, timezone
import unittest

import prune_ghcr_images as prune

NOW = datetime(2026, 11, 14, tzinfo=timezone.utc)


def version(name, age_days, *tags):
    return {"id": hash(name), "digest": "sha256:" + name * 64, "created_at": NOW - timedelta(days=age_days), "tags": list(tags)}


def digest(name):
    return "sha256:" + name * 64


class PrunePlanTest(unittest.TestCase):
    def plan(self, versions, children, keep=1, min_age=10):
        return {v["digest"] for v in prune.plan_prune(versions, lambda d: children.get(d, []), NOW, keep, min_age)}

    def test_old_release_goes_with_its_children_and_the_kept_release_stays_whole(self):
        versions = [
            version("a", 1, "managed-episode-new"),
            version("b", 1),
            version("c", 1),
            version("d", 40, "managed-episode-old"),
            version("e", 40),
            version("f", 40),
        ]
        children = {digest("a"): [digest("b"), digest("c")], digest("d"): [digest("e"), digest("f")]}
        self.assertEqual(self.plan(versions, children), {digest("d"), digest("e"), digest("f")})

    def test_an_old_child_of_a_kept_index_is_never_deleted(self):
        versions = [version("a", 40, "managed-episode-carried"), version("b", 40), version("c", 40)]
        children = {digest("a"): [digest("b"), digest("c")]}
        self.assertEqual(self.plan(versions, children), set())

    def test_attestation_follows_its_subject(self):
        kept = [version("a", 40, "managed-episode-kept"), version("b", 40, "sha256-" + "a" * 64), version("c", 40)]
        self.assertEqual(self.plan(kept, {digest("b"): [digest("c")]}), set())
        orphan = kept + [version("d", 50, "managed-episode-old"), version("e", 50, "sha256-" + "d" * 64)]
        self.assertEqual(self.plan(orphan, {digest("b"): [digest("c")]}, keep=1), {digest("d"), digest("e")})

    def test_an_index_kept_by_age_keeps_its_older_children_and_attestation(self):
        newest = [version(str(n), 1, f"managed-episode-{n}") for n in "abc"]
        young = version("d", 9, "managed-episode-young")
        old_child = version("e", 11)
        attestation = version("f", 11, "sha256-" + "d" * 64)
        attestation_child = version("1", 11)
        versions = newest + [young, old_child, attestation, attestation_child]
        children = {digest("d"): [digest("e")], digest("f"): [digest("1")]}
        self.assertEqual(self.plan(versions, children, keep=3), set())

    def test_an_untagged_index_kept_by_age_keeps_its_older_children(self):
        newest = [version(str(n), 1, f"managed-episode-{n}") for n in "abc"]
        versions = newest + [version("d", 9), version("e", 11), version("f", 11, "sha256-" + "d" * 64), version("1", 11)]
        children = {digest("d"): [digest("e")], digest("f"): [digest("1")]}
        self.assertEqual(self.plan(versions, children, keep=3), set())

    def test_nothing_younger_than_the_minimum_age_is_deleted(self):
        versions = [version("a", 1, "managed-episode-new"), version("b", 2, "managed-episode-new-2"), version("c", 3)]
        self.assertEqual(self.plan(versions, {}), set())


if __name__ == "__main__":
    unittest.main()
