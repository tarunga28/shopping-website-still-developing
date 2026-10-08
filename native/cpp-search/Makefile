# cpp-search — catalog search and ranking engine.
#
# Targets:
#   make            build the static and shared libraries
#   make test       build and run the test suite
#   make bench      build and run the throughput benchmark
#   make clean      remove build output
#
# No dependencies beyond a C++17 compiler, so this builds anywhere the service
# is deployed without a package manager.

CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -fPIC -pthread
# -MMD -MP writes a .d file per object recording which headers it included.
# Without this, editing a header does not rebuild the objects that use it, and
# the result is translation units compiled against DIFFERENT versions of the
# same class. That is an ODR violation: the linker happily combines them, the
# struct sizes disagree, and the process corrupts its own heap at run time.
CXXFLAGS += -MMD -MP
INCLUDES := -Iinclude
BUILD    := build

SOURCES  := src/tokenizer.cpp src/similarity.cpp src/index.cpp src/ffi.cpp
OBJECTS  := $(patsubst src/%.cpp,$(BUILD)/%.o,$(SOURCES))
DEPS     := $(OBJECTS:.o=.d)

STATIC_LIB := $(BUILD)/libcppsearch.a
SHARED_LIB := $(BUILD)/libcppsearch.so

.PHONY: all test bench clean format-check

all: $(STATIC_LIB) $(SHARED_LIB)

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/%.o: src/%.cpp | $(BUILD)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c $< -o $@

$(STATIC_LIB): $(OBJECTS)
	ar rcs $@ $^

$(SHARED_LIB): $(OBJECTS)
	$(CXX) -shared -o $@ $^

$(BUILD)/test_main: tests/test_main.cpp $(SOURCES) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(INCLUDES) $^ -o $@

test: $(BUILD)/test_main
	./$(BUILD)/test_main

$(BUILD)/bench: bench/bench_main.cpp $(SOURCES) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(INCLUDES) $^ -o $@

bench: $(BUILD)/bench
	./$(BUILD)/bench

# Pull in the generated header dependencies. `-` ignores them on the first
# build, when no .d files exist yet.
-include $(DEPS)

clean:
	rm -rf $(BUILD)
