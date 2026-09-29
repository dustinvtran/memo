#!/usr/bin/env bash
# Packs a snapshot directory into one file that only the holder of the
# private key can read, and deletes the plaintext.
#
#   .github/scripts/encrypt_snapshot.sh <snapshot dir> <output file>
#
# **Why this exists.** The repository is public, so its workflow artifacts can
# be downloaded by anyone signed in to GitHub, and a snapshot is the whole
# database: `users`, `apiTokens`, every draft and revision. Until this step
# the backup and the refresh uploaded the directory as it was. An artifact
# is still the right place for the off-machine copy — it is off this laptop
# and off Drive, and it costs nothing — so what changes is that the artifact
# is ciphertext.
#
# **Why a public key rather than a passphrase secret.** The runner only ever
# needs to *encrypt*, and a public key can sit in the repository beside this
# script. Nothing on GitHub can decrypt a snapshot: not the runner, not a
# leaked Actions secret, not someone with write access. The private key lives
# with the owner, and `src/db_maintenance/README.md` says how to decrypt.
#
# It fails closed. With no recipient in `backup_recipients.txt` it exits
# non-zero before anything is uploaded, so a missing key is a red run rather
# than a plaintext artifact.
set -euo pipefail

dir=${1:?snapshot directory}
out=${2:?output file}
recipients="$(dirname "$0")/../backup_recipients.txt"

if ! grep -q '^age1' "$recipients"; then
  echo "::error::No age public key in .github/backup_recipients.txt, so the snapshot cannot be encrypted and will not be uploaded. See src/db_maintenance/README.md, \"Encrypted snapshot artifacts\"."
  exit 1
fi

tar -C "$dir" -czf - . | age --encrypt --recipients-file "$recipients" --output "$out"

# An age file starts with its version line. Checked rather than trusted, since
# the upload that follows would happily keep an empty file for 90 days.
if [ "$(head -c 21 "$out")" != "age-encryption.org/v1" ]; then
  echo "::error::$out is not an age file; not uploading it."
  exit 1
fi

rm -rf "$dir"
echo "Encrypted $(du -h "$out" | cut -f1) to $out; plaintext removed."
