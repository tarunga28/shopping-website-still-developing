# c-importer — bulk catalog ingestion utility.
#
# Targets:
#   make        build the static and shared libraries
#   make test   build and run the test suite
#   make clean  remove build output
#
# Plain C99 with no dependencies: this runs wherever the app is deployed,
# including slim containers with no package manager.

CC       ?= gcc
CFLAGS   ?= -std=c99 -O2 -Wall -Wextra -Wpedantic -fPIC -D_POSIX_C_SOURCE=200809L
# Record header dependencies per object. Without this, editing importer.h does
# not rebuild importer.o, and a library can end up mixing translation units
# compiled against different versions of the same header.
CFLAGS   += -MMD -MP
INCLUDES := -Iinclude
BUILD    := build

SOURCES    := src/importer.c
OBJECTS    := $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
DEPS       := $(OBJECTS:.o=.d)
STATIC_LIB := $(BUILD)/libcimporter.a
SHARED_LIB := $(BUILD)/libcimporter.so

.PHONY: all test clean

all: $(STATIC_LIB) $(SHARED_LIB)

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/%.o: src/%.c include/importer.h | $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) -c $< -o $@

$(STATIC_LIB): $(OBJECTS)
	ar rcs $@ $^

$(SHARED_LIB): $(OBJECTS)
	$(CC) -shared -o $@ $^

$(BUILD)/test_importer: tests/test_importer.c $(SOURCES) | $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) $^ -o $@

test: $(BUILD)/test_importer
	./$(BUILD)/test_importer

-include $(DEPS)

clean:
	rm -rf $(BUILD)
