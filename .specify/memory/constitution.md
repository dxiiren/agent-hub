# agent-hub constitution

1. Adopt before inventing: reuse the daemon and open-source tools; write only the glue nothing covers.
2. Zero core diff for v1: plugins, config and scripts only.
3. Agent-neutral: nothing in the glue is specific to one client.
4. No infra in the public repo: hosts, URLs and credentials are placeholders or git-ignored local files.
5. Counts only: usage capture never stores prompts.
6. Proof on the exact commit: raw result lines and screenshots before any merge.
7. Works on Windows and Linux.
