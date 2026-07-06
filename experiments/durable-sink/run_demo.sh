#!/usr/bin/env bash
#
# run_demo.sh — the controlled reproduction of "the database goes down."
#
# Timeline:
#   0s   bring up redis + db + sink, start the producer (4000 events @ 200/s)
#   ~4s  KILL the database mid-stream
#   ~4-14s  events keep flowing into the Redis stream; the sink holds+retries;
#           the buffered gap (produced - sunk) climbs on screen
#   ~14s  bring the database back
#         the sink drains the backlog; the gap collapses to 0
#   end  run verify.py -> asserts zero loss + dedup, prints PASS/FAIL
#
# Everything is namespaced under project 'durable-sink' and torn down clean
# (down -v) at start, so runs are reproducible and independent of your real stack.

set -euo pipefail
cd "$(dirname "$0")"

PROJECT=durable-sink
DC="docker compose -p $PROJECT"
TARGET=4000

say() { printf "\n\033[1;36m== %s ==\033[0m\n" "$*"; }

redis_get() { $DC exec -T redis redis-cli get "$1" 2>/dev/null | tr -d '\r'; }
stream_len() { $DC exec -T redis redis-cli xlen plate_reads 2>/dev/null | tr -d '\r'; }
# Un-acked backlog for the consumer group (first line of XPENDING summary = count).
pending_count() { $DC exec -T redis redis-cli xpending plate_reads sink 2>/dev/null | head -1 | tr -dc '0-9'; }

snapshot() {
  local u s x buf
  u=$(redis_get produced:unique); u=${u:-0}
  s=$(redis_get sunk:total);      s=${s:-0}
  x=$(stream_len);                x=${x:-0}
  buf=$(( u - s ))
  printf "   produced=%-6s sunk=%-6s buffered(in-flight)=%-6s stream_len=%-6s\n" \
         "$u" "$s" "$buf" "$x"
}

wait_db_healthy() {
  for _ in $(seq 1 30); do
    if $DC exec -T db pg_isready -U postgres >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "db never became healthy" >&2; exit 1
}

say "CLEAN SLATE (down -v + build)"
$DC down -v --remove-orphans >/dev/null 2>&1 || true
$DC build

say "START redis + db + sink"
$DC up -d redis db
wait_db_healthy
$DC up -d sink
sleep 2

say "START producer ($TARGET events @ 200/s)"
$DC up -d producer
sleep 4
snapshot

say "💥 DATABASE DOWN (docker compose stop db)"
$DC stop db
for _ in $(seq 1 5); do sleep 2; snapshot; done
echo "   ^ sink is holding events; stream_len keeps growing, sunk is frozen."

say "🔌 DATABASE RECOVERED (docker compose start db)"
$DC start db
wait_db_healthy

say "DRAINING backlog"
for _ in $(seq 1 40); do
  sleep 1; snapshot
  u=$(redis_get produced:unique);  u=${u:-0}
  s=$(redis_get sunk:total);       s=${s:-0}
  p=$(pending_count);              p=${p:-0}
  # done when the producer has emitted everything, the sink has caught up,
  # AND every stream entry (including trailing duplicates) has been acked.
  if [ "$u" -ge "$TARGET" ] && [ "$s" -eq "$u" ] && [ "$p" -eq 0 ]; then break; fi
done
sleep 2   # settle: let any final in-flight ack land before asserting

say "VERIFY"
$DC --profile manual run --rm verify || true

echo
echo "Stack left running for inspection. Useful commands:"
echo "   $DC logs sink | tail -30"
echo "   $DC exec db psql -U postgres traffic -c 'select count(*) from plate_reads;'"
echo "   $DC down -v         # tear everything down"
