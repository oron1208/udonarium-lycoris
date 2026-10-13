"""Restore the saved v2.0 frontend locally, without deleting newer assets/data."""
from pathlib import Path
import os, shutil

root = Path(__file__).resolve().parents[1]
stable = root / 'tmp/release-v2.2/rollback/udonarium-lycoris'
live = root / 'dist/udonarium-lycoris'
assert stable.joinpath('index.html').is_file(), 'saved v2.0 assets not found'
config = live.joinpath('assets/config.yaml').read_bytes()
for source in stable.rglob('*'):
    if not source.is_file() or source.relative_to(stable) == Path('index.html'):
        continue
    target = live / source.relative_to(stable)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
live.joinpath('assets/config.yaml').write_bytes(config)
staging = live / '.rollback-v2.0-index.html'
shutil.copy2(stable/'index.html', staging)
os.replace(staging, live/'index.html')
print('Restored local v2.0 frontend. Local config and room data preserved; reload browser.')
