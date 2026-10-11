from fib import fib

def test_fib():
    assert fib(0) == 0
    assert fib(1) == 1
    assert fib(2) == 1
    assert fib(5) == 5

if __name__ == "__main__":
    test_fib()
    print("OK")
