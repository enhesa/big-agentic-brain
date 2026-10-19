import os, subprocess, sys, tempfile, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = "import sys; sys.path.insert(0, %r); from geo.cache import DiskCache; c = DiskCache(sys.argv[1]); v = c.get('k:%s'); print('HIT' if v == 42 else 'MISS'); c.set('k:%s', 42)"
class HiddenTest(unittest.TestCase):
    def test_many_keys_across_processes(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(5):
                code = CODE % (ROOT, i, i)
                a = subprocess.check_output([sys.executable, "-c", code, d], env={**os.environ, "PYTHONHASHSEED": "random"}).decode().strip()
                b = subprocess.check_output([sys.executable, "-c", code, d], env={**os.environ, "PYTHONHASHSEED": "random"}).decode().strip()
                self.assertEqual((a, b), ("MISS", "HIT"))
