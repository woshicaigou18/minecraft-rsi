"""Versioned executable artifacts, subprocess preflight and atomic promotion."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((Path(__file__).parent / 'runtime_contract.json').read_text(encoding='utf-8'))
EXECUTABLE = {'skill', 'client_tool', 'config'}


def read(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def atomic(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def build(proposal: dict) -> dict:
    artifact = proposal.get('artifact')
    if not isinstance(artifact, dict) or artifact.get('kind') != proposal['component']:
        raise ValueError('artifact kind must match the component')
    native = artifact.get('kind') == 'skill' and artifact.get('implementation') == 'javascript'
    if not native and artifact.get('target') not in CONTRACT['commands']:
        raise ValueError('unsupported executable target')
    if native:
        import re
        if not re.fullmatch(r'[a-z][a-z0-9_]{2,40}', str(artifact.get('name', ''))) or artifact.get('target') != '!skill_' + artifact['name']:
            raise ValueError('invalid new JavaScript skill name')
        if not isinstance(artifact.get('source'), str):
            raise ValueError('native skill source is missing')
        artifact = {**artifact, 'source': artifact['source'].strip()}
    encoded = json.dumps(artifact, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    if len(encoded) > (48000 if native else 6000):
        raise ValueError('artifact is too large')
    return {**artifact, **({'source_sha256': hashlib.sha256(artifact['source'].encode()).hexdigest()} if native else {}),
            'id': 'artifact-' + hashlib.sha256(encoded.encode()).hexdigest()[:16],
            'scope': proposal.get('scope', 'general'), 'topic': proposal.get('topic', 'runtime_change')}


def preflight(artifact: dict) -> dict:
    try:
        native = artifact.get('implementation') == 'javascript'
        result = subprocess.run(['node', str(ROOT / 'scripts' / ('evaluate-native-skill.mjs' if native else 'evaluate-runtime-artifact.mjs'))],
            input=json.dumps({'artifact': artifact}), capture_output=True, text=True,
            encoding='utf-8', timeout=18 if native else 8, cwd=ROOT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        report = json.loads(result.stdout)
        if result.returncode != 0:
            report['passed'] = False
        return report
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {'passed': False, 'reason': str(error)[:200]}


def stage_native(artifact: dict, directory: Path, report=None):
    if artifact.get('implementation') != 'javascript':
        return
    target = directory / 'skills' / artifact['id']
    target.mkdir(parents=True, exist_ok=True)
    # Preserve source bytes on Windows: newline translation would invalidate SHA256.
    (target / 'skill.js').write_bytes(('export default ' + artifact['source'] + '\n').encode('utf-8'))
    atomic(target / 'manifest.json', {key: value for key, value in artifact.items() if key not in {'source', 'tests'}})
    atomic(target / 'tests.json', artifact['tests'])
    if report is not None:
        atomic(target / 'evaluation.json', report)


def artifact_ready(trial: dict, directory: Path) -> bool:
    active = read(directory / 'active_extensions.json', {'revision': 0})
    quarantine = read(directory / 'extension_quarantine.json', {'ids': []})
    return (trial['artifact']['id'] not in quarantine['ids'] and
            trial.get('base_extension_revision', 0) == active.get('revision', 0))


def promote(artifact: dict, directory: Path, evidence: dict) -> int:
    path = directory / 'active_extensions.json'
    old = read(path, {'revision': 0, 'artifacts': []})
    rows = [row for row in old['artifacts'] if row['target'] != artifact['target']]
    rows.append({**artifact, 'evidence': evidence})
    state = {'revision': old['revision'] + 1, 'artifacts': rows,
             'previous': {'revision': old['revision'], 'artifacts': old['artifacts']}}
    atomic(path, state)
    return len(rows)
