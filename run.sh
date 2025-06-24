#!/bin/bash

# Usage: ./run_on_dataset.sh /path/to/dataset [MAX_JOBS]
# Default MAX_JOBS=4

DATASET_DIR="$1"
MAX_JOBS="${2:-4}"
ERROR_LOG="$DATASET_DIR/errors.log"

if [[ -z "$DATASET_DIR" ]]; then
  echo "Usage: $0 /path/to/dataset [MAX_JOBS]"
  exit 1
fi

# Clear previous error log
echo "" > "$ERROR_LOG"

# Function to process a single folder
process_folder() {
  FOLDER="$1"
  INPUT_WAV="$FOLDER/input.wav"
  OUTPUT_WAV="$FOLDER/combined.wav"
  GPT_WAV="$FOLDER/combined_gpt_response.wav"
  FINAL_WAV="$FOLDER/output.wav"

  if [[ ! -f "$INPUT_WAV" ]]; then
    echo "[$FOLDER] input.wav not found" >> "$ERROR_LOG"
    return
  fi

  # Run the CLI
  if ! npm run cli -- --input "$INPUT_WAV" --output "$OUTPUT_WAV" > "$FOLDER/cli.log" 2>&1; then
    echo "[$FOLDER] CLI failed (see $FOLDER/cli.log)" >> "$ERROR_LOG"
    return
  fi

  # Move/rename the GPT response file
  if [[ ! -f "$GPT_WAV" ]]; then
    echo "[$FOLDER] combined_gpt_response.wav not found after CLI" >> "$ERROR_LOG"
    return
  fi

  if ! mv -f "$GPT_WAV" "$FINAL_WAV"; then
    echo "[$FOLDER] Failed to move combined_gpt_response.wav to output.wav" >> "$ERROR_LOG"
    return
  fi
}

# Job control
job_count=0
for FOLDER in "$DATASET_DIR"/*; do
  [[ -d "$FOLDER" ]] || continue
  BASENAME=$(basename "$FOLDER")
  [[ "$BASENAME" =~ ^[0-9]+$ ]] || continue

  process_folder "$FOLDER" &
  ((job_count++))

  # Limit parallel jobs
  if (( job_count >= MAX_JOBS )); then
    wait -n
    ((job_count--))
  fi

done

# Wait for all jobs to finish
wait

echo "Processing complete. Check $ERROR_LOG for any errors."
