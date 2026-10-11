#!/usr/bin/env python3
"""Guard: the decision contract in every runnable Colab script must stay
byte-identical to scripts/decision-bench.py's, or local and remote eval
numbers are not comparable.

The shared block runs from `ABSTAIN_ID = 'abstain'` through the closing brace
of the CONTRACT dict. Each script copies it verbatim; this check proves it.
"""

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "scripts/decision-bench.py",
    "scripts/colab_train_router_v2.py",
    "scripts/colab_zero_shot.py",
    "scripts/colab_teacher_label.py",
    "scripts/colab_overnight_loop.py",
]
CONTRACT_RE = re.compile(r"ABSTAIN_ID = 'abstain'.*?\n\}", re.S)


def extract_contract(text):
    match = CONTRACT_RE.search(text)
    if not match:
        return None
    return "\n".join(line.rstrip() for line in match.group(0).splitlines())


def main():
    hashes = {}
    missing = []
    for rel in FILES:
        path = ROOT / rel
        if not path.exists():
            missing.append(rel)
            continue
        block = extract_contract(path.read_text(encoding="utf-8"))
        if block is None:
            missing.append(f"{rel} (no contract block)")
            continue
        hashes[rel] = hashlib.sha256(block.encode("utf-8")).hexdigest()[:12]

    reference = hashes.get("scripts/decision-bench.py")
    bad = bool(missing) or any(h != reference for h in hashes.values())
    for rel, h in hashes.items():
        print(f"{'ok  ' if h == reference else 'DRIFT'} {h}  {rel}")
    for rel in missing:
        print(f"MISSING {rel}")
    if bad:
        print("\nContract drift detected. Re-copy the block from scripts/decision-bench.py.")
        sys.exit(1)
    print("\nAll contract blocks match scripts/decision-bench.py.")
    sys.exit(0)


if __name__ == "__main__":
    main()