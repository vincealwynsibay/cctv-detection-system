# Manuscript Update Changelog

Output file: `/Users/vincealwynn/Downloads/EyeGila Manuscript (3).docx`
Original preserved at: `/Users/vincealwynn/Downloads/EyeGila Manuscript (2).docx`

---

## Model checkpoint update

`server/ml/temporal_cnn_model.pt` replaced with the Toronto-trained 4-head checkpoint
(`runs/real_cnn/real_cnn_seed0.pt`). The server now loads the real-data model by default
without needing an env var. Dashboard badge will show emerald "Real-trained CNN" instead
of amber "Synthetic CNN".

---

## Word document changes

### Section 3.4 — Replaced entirely

Old content: Multilayer Perceptron description, Tables 3.3-3.4 (MLP results), Figures 3.7-3.10 (MLP training curves, MLP metrics, MLP per-warrant, MLP confusion matrices).

New content:

| Added | Description |
|---|---|
| **3.4 intro paragraph** | Framing: temporal CNN vs scalar MLP |
| **3.4.1 Model Architecture** | Input shape, temporal branch (3x Conv1D), metadata branch, late fusion, warrant head (sigmoid), intervention head (softmax), ~62,633 params, uncertainty-weighted loss |
| **3.4.2 Synthetic Baseline Training** | Synthetic data purpose, 900-sample test results |
| **Table 3.3** | Per-warrant synthetic CNN: W1 AUC 0.984 F1 0.809 / W2 0.977 0.826 / W3 0.989 0.797 / W4 0.956 0.044 / W-Local-2 N/A 0.000 / W-Local-3 0.999 0.936 / Macro 0.977 0.838 |
| **3.4.3 Real-Data Retraining and Distribution Shift Ablation** | Toronto TMC dataset rationale, zero-padding, dropped heads, epoch 47 checkpoint |
| **Table 3.4** | Ablation: synthetic (0.720 acc, 0.732 AUC) vs Toronto (0.884 acc, 0.956 AUC), delta column |
| **Figure 3.7** | Bar chart: ablation comparison (amber = synthetic, green = Toronto) |
| **Table 3.5** | Toronto per-warrant: W1-W4 full metrics (Accuracy, Precision, Recall, F1, AUC, AP) |
| **Figure 3.8** | Grouped bar chart: per-warrant performance (W1-W4 + Macro) |
| **3.4.4 Intervention Classification** | 3-class head results, timing_only recall 0.200→0.700, 5,109 samples/sec |
| **Table 3.6** | Intervention: Signalize F1 0.588 / Road Widening F1 0.980 / Timing F1 0.778 / Macro F1 0.782 |
| **Figure 3.9** | Bar chart: intervention precision/recall/F1 per class |

---

### Minor reference patches

| Location | Change |
|---|---|
| System Architecture — Recommendation Layer | "Warrant 1, 2, and 4" → "Warrant 1, 2, 3, and 4"; "overall signal recommendation" → "intervention recommendation (signalize, road widening, or timing optimization)" |
| Section 2.6.1 Backend — Warrant Module | MLP description (5 inputs, 64-32-4 neurons, 10,000 samples) replaced with TemporalWarrantCNN description (Toronto-trained, 93-sample eval, 60 unseen intersections). Follow-up "Evaluates peak hour volumes..." line deleted. |
| Section 2.6.2 Frontend — Warrant page | "Warrant 1, 2, and 4 confidence scores and overall recommendation" → "Warrant 1, 2, 3, and 4 confidence scores and intervention recommendation" |
| Conclusion 4.1 — Third finding | MLP F1 sentence replaced with: macro F1 0.908, macro AUC 0.956, 93 samples, 60 intersections, 24.5-point gap closed to 2.1 points |
| Conclusion 4.1 — Limitations | "MUTCD-based criteria" warrant limitation → Toronto distribution, generalization to Philippine context, signalize class F1 0.588 |
| Recommendation 1 (4.2) | "MUTCD-based criteria dataset" → "Toronto intersections, validate against Tagum City ground truth" |

---

## What was NOT changed

- Section 3.1 Detection Model Performance (YOLO) — untouched
- Section 3.2 Error Analysis (YOLO) — untouched
- Section 3.3 System Performance (YOLO) — untouched
- Section 3.5 Summary of Findings — untouched (still numbered 3.5)
- Tables 3.1 and 3.2 — untouched
- Figures 3.1 through 3.6 — untouched
- All references, introduction, scope sections — untouched
- Signal timing (Webster's formula) and Monte Carlo simulation — not added to Results (not novel algorithms; already mentioned in methodology at Section 2.6.1)
