#!/usr/bin/env python3
"""Entry point: python3 reframe_9x16.py <frame.io link | folder> [options]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from r9x16.cli import main  # noqa: E402
sys.exit(main())
