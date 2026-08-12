export function exitCodeForVerifyResults(results) {
  if (results.some((result) => result.status === "fail" || result.status === "error")) {
    return 1;
  }
  return results.some((result) => result.status === "skipped") ? 2 : 0;
}
