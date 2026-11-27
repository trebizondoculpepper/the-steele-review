#!/bin/bash
# Removes the #952 proof's test-namespace indexes (by exact name) and work directories.
ES="$1"; NS=steele-review-proof952
for i in $(curl -s "$ES/_cat/indices/$NS-*?h=index"); do case "$i" in $NS-*) curl -s -XDELETE "$ES/$i" >/dev/null && echo "deleted $i";; esac; done
rm -rf "$HOME"/steele-952-proof.*
echo "remaining: $(curl -s "$ES/_cat/indices/$NS-*?h=index" | wc -l)"
