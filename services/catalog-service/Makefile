# Catalog-intelligence service.
#
#   make install   create the venv and install dependencies
#   make build     build the native ranking engine this service loads
#   make test      run the test suite (no database required)
#   make dev       run the API with reload
#   make lint      syntax-check every module
#   make clean     remove build output and caches

VENV     := .venv
BIN      := $(VENV)/bin
ROOT     := ../..

.PHONY: install build test dev lint clean

$(VENV)/bin/python:
	python3 -m venv $(VENV)
	$(BIN)/pip install --upgrade pip

install: $(VENV)/bin/python
	$(BIN)/pip install -r requirements.txt

build:
	$(MAKE) -C $(ROOT)/native/cpp-search all

test: install
	$(BIN)/python -m pytest -q tests

dev: install
	$(BIN)/uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload

lint: install
	$(BIN)/python -m compileall -q app tests

clean:
	rm -rf $(VENV) .pytest_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
