# Fine-tune the local qwen on the bot's own site traffic.
#
#   python train_sft.py
#
# Input : training/sft.jsonl   (build it with:  node scripts/export-sft.js)
# Output: training/lora-qwen   (a LoRA adapter, ~50-100MB, mergeable into the base)
#
# Then point the bot at the result:
#   ollama create site-kerani -f Modelfile.kerani
#   (Modelfile.kerani is written at the end of this run)
#
# Requires (install in a venv with CUDA 12):
#   pip install unsloth torch transformers datasets trl peft
#
# NOTE: this has NOT been run on this machine yet - the 8GB RTX 4060 has enough
# VRAM for a LoRA on qwen3:4b (4-bit) but you need the CUDA torch build first.
# Everything else in the bot already works without this step; training is what
# removes the remaining "8B is inconsistent" wobble (echoing a question,
# occasionally picking chat over record).

import json, os, random
from pathlib import Path

from datasets import Dataset
from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments

ROOT = Path(__file__).parent
DATA = ROOT / "training" / "sft.jsonl"
OUT = ROOT / "training" / "lora-qwen"
BASE = "unsloth/qwen3-4b"          # must match OLLAMA_MODELS primary
MAX_SEQ = 4096                      # covers system + snapshot + reply

def load_rows():
    rows = []
    with open(DATA, encoding="utf8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    # Small set: repeat so the optimiser actually moves. Drops out fast once
    # there are hundreds of real rows.
    reps = max(1, min(8, 200 // max(1, len(rows))))
    out = []
    for _ in range(reps):
        random.shuffle(rows)
        out.extend(rows)
    return out

def main():
    rows = load_rows()
    print(f"{len(rows)} training rows (with repeats)")

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE,
        max_seq_length=MAX_SEQ,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )

    def to_text(r):
        return tokenizer.apply_chat_template(
            [
                {"role": "system", "content": r["system"]},
                {"role": "user", "content": r["user"]},
                {"role": "assistant", "content": r["assistant"]},
            ],
            tokenize=False,
            add_generation_prompt=False,
        )

    ds = Dataset.from_list([{"text": to_text(r)} for r in rows])

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        dataset_text_field="text",
        max_seq_length=MAX_SEQ,
        packing=True,
        args=TrainingArguments(
            per_device_train_batch_size=1,
            gradient_accumulation_steps=8,
            warmup_steps=10,
            max_steps=300,
            learning_rate=2e-4,
            lr_scheduler_type="cosine",
            logging_steps=5,
            output_dir=str(OUT),
            save_strategy="steps",
            save_steps=100,
            bf16=True,
            optim="adamw_8bit",
            seed=3407,
        ),
    )
    trainer.train()
    model.save_pretrained(str(OUT))
    tokenizer.save_pretrained(str(OUT))
    print("adapter saved to", OUT)

    modelfile = OUT / "Modelfile.kerani"
    modelfile.write_text(
        f'FROM {BASE}\n'
        f'ADAPTER {OUT}\n'
        'PARAMETER temperature 0.2\n'
        'PARAMETER num_ctx 8192\n',
        encoding="utf8",
    )
    print("wrote", modelfile)
    print("next:  ollama create site-kerani -f", modelfile)
    print('then:  OLLAMA_MODELS=site-kerani,qwen3:8b,qwen3:4b')

if __name__ == "__main__":
    main()