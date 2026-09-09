#!/bin/bash
npx tsx scripts/verify.ts POST /v1/ai/complete "$1" 2>/dev/null | sed -n '/^{/,$p'
