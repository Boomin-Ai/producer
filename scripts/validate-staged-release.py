#!/usr/bin/env python3
"""Verify the provenance of a staged release before resuming Windows qualification."""

import base64
from datetime import datetime, timezone
import json
import os
import re
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def api(repo, path, *, paginated=False):
    options = ['--paginate', '--slurp'] if paginated else []
    output = subprocess.check_output(['gh', 'api', *options, f'repos/{repo}/{path}'], text=True)
    return json.loads(output)


def validate(repo, run_id, version):
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+', repo)
            and repo.split('/')[1] not in ('.', '..'), 'Invalid repository')
    require(re.fullmatch(r'[1-9][0-9]*', run_id), 'Expected one numeric release run ID')
    require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version),
            'Expected a stable release version')
    run_id = int(run_id)
    endpoint = f'actions/runs/{run_id}'
    run = api(repo, endpoint)
    sha = run['head_sha']
    repo_id = run['repository']['id']
    require(run['id'] == run_id and run['repository']['full_name'].casefold() == repo.casefold()
            and run['head_repository']['id'] == repo_id, 'Release run must belong to this repository')
    require(run['name'] == 'Release' and run['path'] == '.github/workflows/release.yml'
            and run['event'] == 'workflow_dispatch', 'Expected a dispatched Release workflow')
    require(run['status'] == 'completed' and run['conclusion'] == 'failure',
            'Expected a completed release with a qualification failure')
    # Artifact metadata identifies the run, so restrict recovery to its original attempt.
    require(run['run_attempt'] == 1, 'Release retries do not establish which attempt produced the artifact')
    require(re.fullmatch(r'[0-9a-f]{40}', sha) and run['head_branch'] == f'release/{version}',
            'Release run source and branch must match the requested stable version')
    config = api(repo, f'contents/src-tauri/tauri.conf.json?ref={sha}')
    require(config['encoding'] == 'base64'
            and json.loads(base64.b64decode(config['content']))['version'] == version,
            'Packaged version does not match the requested release')

    pages = api(repo, f'{endpoint}/attempts/1/jobs?per_page=100', paginated=True)
    jobs = [job for page in pages for job in page['jobs']]
    by_name = {job['name']: job for job in jobs}
    require(len(jobs) == len(by_name), 'Release job names must be unique')
    for job in jobs:
        require(job['run_id'] == run_id and job['head_sha'] == sha and job['run_attempt'] == 1
                and job['status'] == 'completed', f'Invalid provenance or status for {job["name"]}')
        if job['name'] != 'build-windows-live':
            require(job['conclusion'] in ('success', 'skipped'), f'Unexpected release failure in {job["name"]}')

    def job(name, conclusion):
        entry = by_name.get(name)
        require(entry and entry['conclusion'] == conclusion, f'Expected {name} to be {conclusion}')
        return entry

    def step(entry, name, conclusion='success'):
        matches = [item for item in entry['steps'] if item['name'] == name]
        require(len(matches) == 1 and matches[0]['status'] == 'completed'
                and matches[0]['conclusion'] == conclusion, f'Expected {name} to be {conclusion}')

    step(job('validate-public-source', 'success'), 'Validate stable source and reserve one release draft')
    step(job('build (ubuntu-latest)', 'success'), 'Run tauri-apps/tauri-action@v0')
    intel = job('build-macos-intel-live', 'success')
    step(intel, 'Stage Intel installer in the release draft')
    step(intel, 'Stage notarized Intel updater archive')
    arm = job('build-macos-arm64-live', 'success')
    step(arm, 'Stage Apple Silicon installer in the release draft')
    step(arm, 'Stage notarized Apple Silicon updater archive')
    job('publish-verified-release', 'skipped')
    job('promote-signed-candidate', 'skipped')

    windows = job('build-windows-live', 'failure')
    for name in (
        'Gate - engine closure',
        'Build NSIS installer (engine linked + staged beside producer.exe)',
        'Preserve Windows installer before runtime checks',
        'Qualify installed Windows engine',
        'Check Windows native compositor linkage',
        'Preserve Windows installed and runtime evidence',
    ):
        step(windows, name)
    prerequisite = 'Ensure recording inspection prerequisite'
    step(windows, prerequisite, 'failure')
    failures = [item['name'] for item in windows['steps'] if item['conclusion'] not in ('success', 'skipped')]
    require(failures == [prerequisite], 'Only the recording inspection prerequisite may have failed')
    for name in ('Prepare Windows native runtime qualification', 'Qualify Windows native runtime',
                 'Stage Windows installers in the release draft'):
        step(windows, name, 'skipped')

    pages = api(repo, f'{endpoint}/artifacts?per_page=100', paginated=True)
    artifacts = [item for page in pages for item in page['artifacts']]

    def preserved_artifact(name):
        matches = [item for item in artifacts if item['name'] == name]
        require(len(matches) == 1, f'Expected one preserved artifact named {name}')
        artifact = matches[0]
        origin = artifact['workflow_run']
        require(origin['id'] == run_id and origin['head_sha'] == sha and origin['repository_id'] == repo_id
                and origin['head_repository_id'] == repo_id, f'{name} has different build provenance')
        expiry = datetime.fromisoformat(artifact['expires_at'].replace('Z', '+00:00'))
        require(artifact['expired'] is False and artifact['size_in_bytes'] > 0
                and expiry > datetime.now(timezone.utc), f'{name} is expired or empty')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', artifact['digest']), f'Missing digest for {name}')
        return artifact

    installer = preserved_artifact(f'Producer-windows-x64-unqualified-{sha}')
    proof = preserved_artifact(f'producer-windows-qualification-{sha}')
    # Capture the log privately and extract only the engine resolver's run ID.
    log = subprocess.check_output([
        'gh', 'api', '--allow-escape-sequences', f'repos/{repo}/actions/jobs/{windows["id"]}/logs',
    ], text=True, errors='replace')
    engine_runs = re.findall(r'(?m)^\d{4}-\d{2}-\d{2}T[0-9:.]+Z found in run ([1-9][0-9]*)[ \t]*$', log)
    require(len(engine_runs) == 1, 'Expected one exact engine artifact run in the Windows build log')
    return {
        'source': sha, 'version': version, 'runId': run_id, 'windowsJobId': windows['id'],
        'artifactId': installer['id'], 'artifactName': installer['name'], 'artifactDigest': installer['digest'],
        'proofArtifactId': proof['id'], 'proofArtifactDigest': proof['digest'], 'engineRunId': int(engine_runs[0]),
    }


if __name__ == '__main__':
    try:
        receipt = validate(os.environ['GITHUB_REPOSITORY'], os.environ['RESUME_WINDOWS_RUN'],
                           os.environ['RELEASE_VERSION'])
    except (KeyError, TypeError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'Cannot resume staged release: {error}')
    print(json.dumps(receipt))
