import warnings
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    module=r".*pkg_resources.*",
)
warnings.filterwarnings(
    "ignore",
    message=r".*pkg_resources is deprecated as an API.*",
    category=UserWarning,
)
warnings.filterwarnings(
    "ignore",
    category=UserWarning,
    module=r"pyatmos\.standardatmos\.coesa76",
)

import os
import sys
import json
from pathlib import Path

# Disable IERS/EOP download and set certs before any pyatmos/astropy imports
os.environ.setdefault("ENABLE_IERS_LOAD", "0")
try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except Exception:
    pass


def main():
    # Suppress third-party noisy warnings that break tqdm rendering
    try:
        warnings.filterwarnings(
            "ignore",
            category=UserWarning,
            module="pyatmos.standardatmos.coesa76",
        )
        warnings.filterwarnings(
            "ignore",
            message="pkg_resources is deprecated as an API",
            category=UserWarning,
        )
    except Exception:
        pass
    from debris_calculation.debris_from_csv import run_debris_from_csv

    # Determine mode: 'batch' or 'single'
    # Priority: CLI arg > ENV SIM_MODE > default 'batch'
    mode = None
    if len(sys.argv) > 2:
        mode = sys.argv[2].strip().lower()
    if not mode:
        mode = (os.environ.get("SIM_MODE", "") or "").strip().lower()
    if mode not in ("debris_from_csv_batch", "debris_from_csv_single", "batch", "single"):
        mode = "batch"
    mode_clean = "batch" if mode in ("batch", "debris_from_csv_batch") else "single"

    # Config path: CLI arg > ENV > default
    cfg = None
    if len(sys.argv) > 1:
        cfg = sys.argv[1]
    if not cfg:
        cfg = os.environ.get(
            "DEBRIS_CONFIG",
            "json_files/json_debris/debris_from_csv_batch.json" if mode_clean == "batch" else "json_files/json_debris/debris_from_csv_single.json",
        )

    result = run_debris_from_csv(cfg, mode=mode_clean)

    # Basic output summary
    print("\n" + "=" * 70)
    print(f"| Debris From CSV ({mode_clean.title()}) |")
    print("=" * 70)
    print(f"Parent folder:   {result.get('parent_folder')}")
    print(f"Rows processed:  {result.get('rows')}")
    print(f"Index CSV:       {result.get('index_csv')}")
    print(f"Index JSON:      {result.get('index_json')}")


if __name__ == "__main__":
    main()
