#!/bin/bash
# #952 proof on the Pi: Git-triggered collection indexing end to end.
# Runs as the account that runs Git. Uses a temporary repository and a
# test-only Elasticsearch namespace; prints a log of each check.
set -u
ES="$1"                      # Elasticsearch URL (private; passed in, never committed)
NS=steele-review-proof952
W=$(mktemp -d "$HOME/steele-952-proof.XXXXXX")
export STEELE_CONFIG_PATH="$W/config" STEELE_COLLECTIONS_ROOT="$W/repo" STEELE_COLLECTIONS_CHECKPOINT="$W/state/collection-index.json" STEELE_INDEX_NAMESPACE="$NS"
mkdir -p "$W/config/elasticsearch"
printf '{"url":"%s"}\n' "$ES" > "$W/config/elasticsearch/connection.json"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1: expected [$3] got [$2]"; fail=$((fail+1)); fi; }
ids() { sleep 2; curl -s "$ES/$NS-$1/_search?size=100&_source=false&sort=provenance.path" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log((r.hits?.hits??[]).map(h=>h._id).join(","))})'; }
field() { curl -s "$ES/$NS-$1/_doc/$2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],r._source);console.log(v??"")})' "$3"; }
others() { curl -s "$ES/_cat/indices?h=index&s=index" | grep -v "^$NS-" ; }
othercounts() { curl -s "$ES/_cat/indices?h=index,docs.count&s=index" | grep -v "^$NS-" ; }

echo "== setup: $(steele-collections 2>&1 | head -c 0; command -v steele-collections), node $(node --version), git $(git --version | cut -d' ' -f3)"
others > "$W/indices-before.txt"; othercounts > "$W/counts-before.txt"
git init -q -b main "$W/repo"
git -C "$W/repo" config user.name proof; git -C "$W/repo" config user.email proof@invalid
steele-collections install-hook --repo "$W/repo"
cd "$W/repo"
mkdir -p alpha beta/nested
cat > alpha/collection.json <<'EOF'
{"mappingVersion":1,"mapping":{"dynamic":"strict","properties":{"title":{"type":"text"},"n":{"type":"integer"}}}}
EOF
cat > beta/collection.json <<'EOF'
{"mappingVersion":2,"mapping":{"dynamic":"strict","properties":{"tag":{"type":"keyword"}}}}
EOF
echo '{"title":"First","n":1}' > alpha/a1.json
echo '{"title":"Second","n":2}' > alpha/a2.json
echo '{"tag":"x"}' > beta/nested/b1.json

echo "== 1. add records in both collections"
git add -A && git commit -q -m "add" 2> "$W/hook1.err"
check "alpha ids after add" "$(ids alpha)" "a1.json,a2.json"
check "beta ids after add" "$(ids beta)" "nested/b1.json"
check "alpha backing index" "$(curl -s "$ES/_alias/$NS-alpha" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).join(",")))')" "$NS-alpha-v1"
check "beta backing index (its own mapping version)" "$(curl -s "$ES/_alias/$NS-beta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).join(",")))')" "$NS-beta-v2"
check "alpha strict mapping" "$(curl -s "$ES/$NS-alpha-v1/_mapping" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=Object.values(JSON.parse(s))[0].mappings;console.log(m.dynamic+":"+m.properties.title.type+":"+m.properties.n.type)})')" "strict:text:integer"
check "beta strict mapping" "$(curl -s "$ES/$NS-beta-v2/_mapping" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=Object.values(JSON.parse(s))[0].mappings;console.log(m.dynamic+":"+m.properties.tag.type)})')" "strict:keyword"
check "provenance revision is HEAD" "$(field alpha a1.json provenance.revision)" "$(git rev-parse HEAD)"
check "no hook errors on add" "$(cat "$W/hook1.err")" ""

echo "== 2. edit one record"
echo '{"title":"First, edited","n":1}' > alpha/a1.json
git commit -q -am "edit"
sleep 2
check "edited title" "$(field alpha a1.json title)" "First, edited"
check "edit provenance revision" "$(field alpha a1.json provenance.revision)" "$(git rev-parse HEAD)"

echo "== 3. rename it"
git mv alpha/a1.json alpha/a1-renamed.json && git commit -q -m "rename"
check "alpha ids after rename" "$(ids alpha)" "a1-renamed.json,a2.json"

echo "== 4. delete it"
git rm -q alpha/a1-renamed.json && git commit -q -m "delete"
check "alpha ids after delete" "$(ids alpha)" "a2.json"
check "beta unaffected" "$(ids beta)" "nested/b1.json"

echo "== 5. invalid record: the hook reports, Git keeps the commit"
echo '{"title":"Bad","undeclared":true}' > alpha/bad.json
git add alpha/bad.json
git commit -q -m "invalid record" 2> "$W/hook5.err"; status=$?
check "git commit status" "$status" "0"
check "commit retained" "$(git log -1 --format=%s)" "invalid record"
grep -q "indexing did not complete; the commit is kept" "$W/hook5.err" && check "hook reported failure" yes yes || check "hook reported failure" no yes
grep -q "recover with: steele-collections reconcile" "$W/hook5.err" && check "hook printed recovery command" yes yes || check "hook printed recovery command" no yes
sed 's/^/    hook: /' "$W/hook5.err"
check "invalid record not searchable" "$(ids alpha)" "a2.json"

echo "== 6. correct the record (commit made with hooks off, as if missed) and run the recovery command"
echo '{"title":"Bad, corrected"}' > alpha/bad.json
git -c core.hooksPath=/dev/null commit -q -am "correct record"
check "not indexed before recovery" "$(ids alpha)" "a2.json"
steele-collections reconcile; echo "    recovery exit status: $?"
check "indexed after recovery" "$(ids alpha)" "a2.json,bad.json"
check "recovered title" "$(field alpha bad.json title)" "Bad, corrected"
steele-collections reconcile --quiet; check "repeat recovery is a no-op" "$?" "0"

echo "== 7. existing indexes untouched"
others > "$W/indices-after.txt"; othercounts > "$W/counts-after.txt"
echo "    document-count differences outside the namespace (other live writers, informational):"; diff "$W/counts-before.txt" "$W/counts-after.txt" | sed 's/^/      /' || true
check "indices outside the test namespace unchanged" "$(diff -q "$W/indices-before.txt" "$W/indices-after.txt" >/dev/null && echo same || echo changed)" "same"
echo "    other indices: $(wc -l < "$W/indices-before.txt")"

echo "== result: $pass passed, $fail failed"
echo "WORKDIR $W"
