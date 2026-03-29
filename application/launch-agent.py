"""
launch-agent.py  —  Windows console-aware agent launcher
Usage: python launch-agent.py <workspace> [model] [launcher]

Spawns the resolved launcher .bat in a NEW console window so Copilot CLI
gets a real TTY (CREATE_NEW_CONSOLE). Prints the child PID to stdout.

If [model] is omitted, the model is auto-discovered from
workspace/<workspace>/config.json (key: "model").
"""
import subprocess
import sys
import os
import json
import re

def sanitize_workspace_name(workspace):
    return re.sub(r'[^A-Za-z0-9._-]', '-', str(workspace or ''))

def resolve_workspace_dir(root_dir, workspace):
    repo_root = os.path.abspath(os.path.join(root_dir, '..'))
    if os.path.basename(repo_root) == workspace:
        return repo_root
    return os.path.join(root_dir, 'workspace', workspace)

def load_workspace_model(root_dir, workspace):
    """Read model from the resolved workspace config.json if present."""
    config_path = os.path.join(resolve_workspace_dir(root_dir, workspace), 'config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            return cfg.get('model', '')
        except Exception:
            pass
    return ''

def resolve_launcher(root_dir, workspace, launcher):
    if launcher:
        return os.path.abspath(launcher)

    workspace_dir = resolve_workspace_dir(root_dir, workspace)

    # Primary: resolved workspace/run.bat
    workspace_launcher = os.path.join(workspace_dir, 'run.bat')
    if os.path.exists(workspace_launcher):
        return workspace_launcher

    # Legacy fallback: resolved workspace/run-agent.bat
    workspace_launcher_legacy = os.path.join(workspace_dir, 'run-agent.bat')
    if os.path.exists(workspace_launcher_legacy):
        return workspace_launcher_legacy

    workspace_launcher = os.path.join(
        root_dir,
        f'run-copilotcli-workspace-{sanitize_workspace_name(workspace or "default")}.bat'
    )
    if os.path.exists(workspace_launcher):
        return workspace_launcher
    return os.path.join(root_dir, 'run-copilotcli-loop.bat')

def main():
    workspace = sys.argv[1] if len(sys.argv) > 1 else 'test'
    model     = sys.argv[2] if len(sys.argv) > 2 else ''
    launcher  = sys.argv[3] if len(sys.argv) > 3 else ''

    root_dir = os.path.dirname(os.path.abspath(__file__))
    bat_file = resolve_launcher(root_dir, workspace, launcher)

    # Auto-discover model from workspace config when not explicitly provided
    if not model:
        model = load_workspace_model(root_dir, workspace)

    env = os.environ.copy()
    if model:
        env['COPILOTCLI_MODEL'] = model

    # CREATE_NEW_CONSOLE gives the child process a real console (TTY).
    # Note: CREATE_NEW_CONSOLE and DETACHED_PROCESS are mutually exclusive on Windows;
    #       CREATE_NEW_CONSOLE alone is sufficient — the child owns its own console
    #       and will survive after this launcher exits.
    CREATE_NEW_CONSOLE = 0x00000010
    command = ['cmd.exe', '/c', bat_file]
    if os.path.basename(bat_file).lower() == 'run-copilotcli-loop.bat':
        command.extend(['-workspace', workspace])

    proc = subprocess.Popen(
        command,
        env=env,
        cwd=os.path.dirname(bat_file),
        creationflags=CREATE_NEW_CONSOLE,
        close_fds=True,
    )

    # Print PID so the Node caller can capture it
    print(proc.pid, flush=True)

if __name__ == '__main__':
    main()
