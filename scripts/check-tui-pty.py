#!/usr/bin/env python3
"""PTY regression and latency probe. Uses only Python's standard library."""
import argparse
import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import statistics
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')

class Terminal:
    def __init__(self, entry, cwd, columns=80, rows=24, no_color=False):
        self.master, slave = pty.openpty()
        self.columns, self.rows = columns, rows
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        env = dict(os.environ, TERM='xterm-256color')
        env.pop('LATTICE_CONFIG', None)
        env.pop('NO_COLOR', None)
        env.pop('FORCE_COLOR', None)
        env['NO_COLOR' if no_color else 'FORCE_COLOR'] = '1'
        self.start = time.perf_counter()
        self.process = subprocess.Popen(['node', str(entry)], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env, start_new_session=True)
        os.close(slave)
        self.raw = ''
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')

    def plain(self):
        return ANSI.sub('', self.raw)

    def until(self, text, timeout=8):
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            if text in self.plain():
                return (time.perf_counter() - self.start) * 1000
            if select.select([self.master], [], [], 0.02)[0]:
                try:
                    self.raw += self.decoder.decode(os.read(self.master, 65536))
                except OSError:
                    break
        raise AssertionError(f'PTY did not display {text!r}: {self.plain()[-5000:]}')

    def send(self, keys, expected=None):
        self.raw = ''
        started = time.perf_counter()
        os.write(self.master, keys.encode())
        if expected:
            self.until(expected)
        return (time.perf_counter() - started) * 1000

    def ready(self):
        deadline = time.perf_counter() + 3
        while termios.tcgetattr(self.master)[3] & termios.ICANON:
            assert time.perf_counter() < deadline, 'CLI did not enable raw keyboard input'
            time.sleep(0.005)
        return (time.perf_counter() - self.start) * 1000

    def resize(self, columns, rows):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)
        self.columns, self.rows = columns, rows

    def close(self):
        if self.process.poll() is None:
            os.write(self.master, b'\x03')
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=3)
        os.close(self.master)


def probe(entry, baseline=False, no_color=False):
    with tempfile.TemporaryDirectory(prefix='lattice-pty-') as cwd:
        tty = Terminal(entry, cwd, no_color=no_color)
        try:
            startup = tty.until('Enter task or /command' if baseline else 'PLAN task or /help')
            startup = max(startup, tty.ready())
            startup_bytes = len(tty.raw.encode())
            latency = tty.send('latency_probe', 'latency_probe')
            if baseline:
                return {'startup_ms': startup, 'input_ms': latency, 'startup_bytes': startup_bytes}
            for mode, color in [('BUILD', '36'), ('AUTO', '35'), ('PLAN', '33')]:
                tty.send('\x1b[Z', f'[{mode}]')
                assert 'latency_probe' in tty.plain(), 'Shift+Tab lost the draft'
                if not no_color:
                    assert f'\x1b[{color}m' in tty.raw, f'{mode} accent absent'
            tty.send('\r', 'BLOCKED')
            assert 'Task Finished' not in tty.plain() and 'VERIFIED PATCH' not in tty.plain()
            tty.send('/mo', '/mo')
            tty.send('\x1b[Z', '[BUILD]')
            tty.send('\t', '/mode ')
            tty.send('auto', '/mode auto')
            tty.send('\r', '[AUTO]')
            tty.send('line one\\', 'line one')
            tty.send('\r')
            time.sleep(0.1)
            tty.send('line two', 'line two')
            assert 'AUTO · line one' not in tty.plain(), 'Continuation submitted the draft'
            tty.send('\r', 'BLOCKED')
            tty.send('\x1b[A', 'line two')
            tty.send('\x15')
            tty.resize(40, 16)
            tty.send('narrow_probe', 'narrow_probe')
            assert 'LATTICE' in tty.plain()
            tty.resize(100, 30)
            tty.send('\x15')
            tty.send('/help', '/help')
            tty.send('\r', 'Shortcuts')
            tty.send('\x1b[5~', 'Available Slash Commands')
            if no_color:
                assert not re.search(r'\x1b\[(?:3[0-7]|9[0-7])m', tty.raw), 'NO_COLOR ignored'
            return {'startup_ms': startup, 'input_ms': latency, 'startup_bytes': startup_bytes}
        finally:
            tty.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--entry', type=Path, default=ROOT / 'apps/cli/dist/index.js')
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--samples', type=int, default=3)
    args = parser.parse_args()
    assert args.samples > 0
    report = {}
    for label, entry, baseline in [('current', args.entry, False), ('baseline', args.baseline, True)]:
        if entry:
            results = [probe(entry, baseline) for _ in range(args.samples)]
            report[label] = {key: round(statistics.median(item[key] for item in results), 2) for key in results[0]}
    probe(args.entry, no_color=True)
    print(json.dumps({'passed': True, 'samples': args.samples, 'medians': report}, indent=2))

if __name__ == '__main__':
    main()
