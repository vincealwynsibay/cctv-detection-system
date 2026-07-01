# Manuscript Warrant Updates

## On the simulation question

Do NOT add Section 3.5 / 3.6 for Webster's formula and Monte Carlo. These are not algorithms you created. They are standard implementations (Webster 1958, well-known Monte Carlo technique). They already appear in the methodology at para 151 ("The system also implements a signal timing optimization module using Webster's formula..."). That is the right place for them. The Results chapter should only cover what was formally evaluated with metrics. Since there are no formal numeric evaluation results for the timing/simulation (no ground truth to compare against, no ablation), adding them to Results would look like padding.

If the panel asks about signal timing: "Signal timing proposals are generated using Webster's formula, which is the DPWH-recommended standard. The system applies it per time-of-day regime derived from k-means clustering of hourly flows. This is a system feature, not a novel algorithmic contribution."

---

## All places that need updating in the manuscript

### 1. Para 68-69 — System Architecture, Recommendation Layer (minor fix)

Currently says: "Outputs confidence scores for Warrant 1, 2, and 4, and an overall signal recommendation per intersection."

Change to: "Outputs confidence scores for Warrant 1, 2, 3, and 4, and an intervention recommendation per intersection (signalize, road widening, or timing optimization)."

---

### 2. Para 149-150 — Section 2.6.1 Backend Development, Warrant Recommendation Module (replace)

Currently says: "A Multilayer Perceptron (5 inputs, 64-32-4 neurons, Sigmoid output) trained on 10,000 samples constructed from thresholds... Evaluates peak hour volumes from the continuous aggregate and outputs confidence scores for Warrant 1, 2, and 4 and an overall recommendation."

Replace with:

> A multi-task temporal convolutional neural network (TemporalWarrantCNN) evaluates a 24-hour vehicle flow matrix of shape (5 × 96) — five approach channels (N, S, E, W, pedestrian) discretized into 96 fifteen-minute slots — together with a five-feature intersection metadata vector. The model outputs per-warrant confidence scores for Warrant 1, 2, 3, and 4 via sigmoid activation, and an intervention class (signalize, road widening, or timing optimization) via softmax. The model was trained on real per-approach traffic counts from the City of Toronto Open Data Multimodal Turning Movement Count dataset and evaluated on a held-out set of 93 samples from 60 unseen intersections.

---

### 3. Para 171 — Frontend, Warrant recommendations page (minor fix)

Currently says: "Warrant recommendations page showing Warrant 1, 2, and 4 confidence scores and overall recommendation per intersection."

Change to: "Warrant recommendations page showing Warrant 1, 2, 3, and 4 confidence scores and intervention recommendation (signalize, road widening, or timing optimization) per intersection."

---

### 4. Section 3.4 — Replace entirely

Delete everything from "3.4 Warrant Classification Model Performance" through to (not including) "3.5 Summary of Findings". Replace with the content below.

---

**Heading 3: 3.4 Warrant Classification Model Performance**

The traffic-signal warrant classifier was implemented as a multi-task temporal convolutional neural network (TemporalWarrantCNN) that operates directly on 24-hour vehicle flow timeseries. Unlike a scalar-feature multilayer perceptron, the temporal CNN captures the shape of traffic demand across the full day, enabling it to distinguish sustained peak-hour patterns from short-duration spikes that share similar aggregate totals.

---

**Heading 4: 3.4.1 Model Architecture**

The model accepts two inputs: a flow matrix of shape (5 × 96) representing five detection channels (northbound, southbound, eastbound, westbound, and pedestrian) each discretized into 96 fifteen-minute intervals; and a five-element intersection metadata vector comprising major-road lane count, minor-road lane count, posted speed (km/h), signalization status, and number of approaches.

The architecture consists of two branches fused before the output heads. The temporal branch applies three one-dimensional convolutional blocks along the time axis, each comprising a Conv1D layer (kernel width 5, filter depths 32, 64, and 128), batch normalization, ReLU activation, and max-pooling with stride 2. Adaptive average pooling produces a fixed 128-dimensional feature vector, which is then mapped through a fully connected layer to 128 dimensions. The metadata branch maps the five intersection features through a linear layer to 16 dimensions with ReLU activation.

The two branches are concatenated (144 dimensions total) and passed through a shared dense layer (144 → 64, ReLU, Dropout 0.3) before splitting into two output heads. The warrant head applies a linear projection followed by sigmoid activation, producing K independent warrant probabilities — K = 6 for the synthetic-trained model (W1, W2, W3, W4, W-Local-2, W-Local-3) and K = 4 for the real-trained model (W1, W2, W3, W4). The intervention head applies a linear projection followed by softmax activation, producing a distribution over three intervention classes: signalize, road widening, and timing optimization. The model contains approximately 62,633 trainable parameters.

Training minimizes a multi-task loss combining binary cross-entropy with logits for the warrant head and cross-entropy for the intervention head. An uncertainty-weighted formulation (Kendall et al., 2018) learns the relative contribution of each task automatically. The Adam optimizer was used with a learning rate of 0.001 and batch size of 64, with early stopping by validation loss.

---

**Heading 4: 3.4.2 Synthetic Baseline Training**

A synthetic training dataset was constructed prior to obtaining real traffic data. A parametric simulator generated 30 simulated intersections over 90 days, producing 24-hour flow profiles with realistic AM and PM peak structures calibrated to Tagum City priors and Philippine PCU composition. Warrant labels were generated programmatically by applying the MUTCD and local warrant evaluators to each simulated day, ensuring exact consistency between the labels and the rules the model approximates. The dataset was split intersection-stratified into 21 training, 4 validation, and 5 test intersections.

Table 3.5 reports per-warrant performance on the 900-sample synthetic test set. The model achieved a macro ROC-AUC of 0.977 across the active warrant heads. Two heads were identified as inactive or unreliable: W-Local-2 produced zero positive predictions (AUC undefined), and W4 achieved high AUC (0.956) but near-zero F1 (0.044), a consequence of extreme class imbalance at 4.9% positive rate in the synthetic distribution. These findings informed the head reduction applied during real-data retraining.

**Table 3.5.** Per-warrant performance of the synthetic-trained TemporalWarrantCNN on the synthetic test set (900 samples, best checkpoint).

| Warrant | AUC | F1 |
|---|---|---|
| W1 – Minimum Vehicular Volume | 0.984 | 0.809 |
| W2 – Interruption of Continuous Traffic | 0.977 | 0.826 |
| W3 – Peak Hour | 0.989 | 0.797 |
| W4 – Pedestrian Volume | 0.956 | 0.044 |
| W-Local-2 | N/A | 0.000 |
| W-Local-3 | 0.999 | 0.936 |
| Macro (active heads, excl. W-Local-2) | 0.977 | 0.838 |

*Note.* AUC = area under the ROC curve. F1 computed at a 0.5 decision threshold on sigmoid outputs. W-Local-2 AUC is undefined due to zero positive predictions in the test set.

---

**Heading 4: 3.4.3 Real-Data Retraining and Distribution Shift Ablation**

The synthetic training regime introduces a risk of distribution shift: a model trained on simulated flows may not generalize to real measured traffic. To quantify and address this, the synthetic-trained model was evaluated on a held-out real-data test set and subsequently retrained on real traffic data.

**Dataset.** The City of Toronto Open Data Multimodal Turning Movement Count (TMC) dataset was selected as the real training source. It provides 15-minute per-approach vehicle and pedestrian counts for 617 unique intersections from 2020 to 2026, available as a single direct-download CSV under the Open Government Licence – Toronto. It is the only publicly available dataset providing real per-direction pedestrian counts at 15-minute granularity without institutional access requirements. Warrant labels were applied using the same MUTCD evaluators used during synthetic training. Toronto TMC studies cover 8 to 14 daytime hours; slots outside the study window were zero-padded. Because zero-padded overnight hours carry no discriminative signal for W-Local-3 (a low-volume nighttime criterion), that head was excluded from the real-trained model. W-Local-2 was also excluded after the synthetic evaluation confirmed zero positive predictions. The real-trained model therefore predicts four warrant heads: W1, W2, W3, and W4. The dataset was split intersection-stratified into 691 training, 89 validation, and 93 test samples; the best checkpoint was selected at epoch 47 by validation loss.

**Ablation.** Table 3.6 compares both models on the same 93-sample held-out real test set. The synthetic-trained model produced a macro AUC of 0.732 on real flows — a 24.5-point drop from its 0.977 performance on synthetic data. Retraining on Toronto flows recovered macro AUC to 0.956, closing the gap to 2.1 AUC points. All classification metrics improved substantially.

**Table 3.6.** Distribution shift ablation: synthetic-trained vs. Toronto-trained TemporalWarrantCNN on the held-out real test set (93 samples, four MUTCD warrant heads).

| Metric | Synthetic-Trained | Toronto-Trained | Delta |
|---|---|---|---|
| Accuracy | 0.720 | 0.884 | +0.164 |
| Precision | 0.792 | 0.889 | +0.096 |
| Recall | 0.784 | 0.932 | +0.148 |
| F1-Score | 0.741 | 0.908 | +0.166 |
| Macro AUC | 0.732 | 0.956 | +0.224 |
| mAP | 0.813 | 0.976 | +0.163 |

*Note.* All metrics are macro-averaged across W1, W2, W3, and W4. mAP = mean average precision (mean area under the precision-recall curve). Evaluated on the same 93-sample held-out real test set.

Table 3.7 reports per-warrant performance of the Toronto-trained model on the real test set.

**Table 3.7.** Per-warrant classification performance of the Toronto-trained TemporalWarrantCNN on the held-out real test set (93 samples).

| Warrant | Accuracy | Precision | Recall | F1 | AUC | AP |
|---|---|---|---|---|---|---|
| W1 – Minimum Vehicular Volume | 0.882 | 0.912 | 0.925 | 0.919 | 0.927 | 0.970 |
| W2 – Interruption of Continuous Traffic | 0.925 | 0.953 | 0.938 | 0.946 | 0.965 | 0.988 |
| W3 – Peak Hour | 0.925 | 0.944 | 0.927 | 0.936 | 0.980 | 0.986 |
| W4 – Pedestrian Volume | 0.806 | 0.746 | 0.936 | 0.830 | 0.954 | 0.959 |
| **Macro** | **0.884** | **0.889** | **0.932** | **0.908** | **0.956** | **0.976** |

*Note.* AP = average precision (area under the precision-recall curve). Metrics computed at a 0.5 decision threshold on sigmoid outputs, except AUC and AP which use raw probabilities.

---

**Heading 4: 3.4.4 Intervention Classification**

In addition to warrant prediction, the model outputs a three-class intervention recommendation: signalize (install new signals), road widening (add approach lanes), or timing optimization (adjust existing signal splits). Table 3.8 reports per-class performance of the Toronto-trained model. The road widening class, constituting 83% of the test set, was classified with near-perfect precision and recall. Timing only recall improved from 0.200 under the synthetic-trained model to 0.700 with retraining — the most pronounced gain from using real data. Signalize F1 (0.588) was lowest owing to a support of only six samples, making precision sensitive to individual predictions. Inference throughput on CPU is 5,109 samples per second (0.196 ms/sample), sufficient for interactive use.

**Table 3.8.** Intervention classification performance of the Toronto-trained model on the real test set (93 samples, overall accuracy 0.925).

| Intervention Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| Signalize | 0.455 | 0.833 | 0.588 | 6 |
| Road Widening | 1.000 | 0.961 | 0.980 | 77 |
| Timing Optimization | 0.875 | 0.700 | 0.778 | 10 |
| Macro | — | — | 0.782 | 93 |

---

### 5. Para 253 — Conclusion 4.1, second paragraph (update warrant finding)

Currently says: "Third, the warrant-classification model distinguished Warrant 1, Warrant 2, and Warrant 4 cases with a high overall F1-score on the held-out test set, showing that accumulated traffic counts can be mapped to MUTCD-based signal warrants."

Replace with:

> Third, the temporal CNN warrant classifier achieved a macro F1 of 0.908 and macro AUC of 0.956 across four MUTCD warrant heads on a held-out real-data test set of 93 samples drawn from 60 Toronto intersections, demonstrating that accumulated 24-hour traffic counts can be reliably mapped to MUTCD-based signal warrant determinations. A distribution shift ablation showed that retraining on real traffic data reduced a 24.5-point AUC gap (synthetic-trained: 0.732 on real data) to 2.1 points, confirming the importance of real measured flows for this task.

---

### 6. Para 254 — Conclusion limitations paragraph (update warrant limitation)

Currently says: "The warrant classifier was evaluated on a dataset constructed from MUTCD-based criteria grounded in field observations and traffic engineering research. Validation against expert warrant determinations on real intersection counts remains necessary..."

Replace warrant limitation sentence with:

> The warrant classifier was trained and evaluated on the Toronto Open Data TMC dataset, which covers Canadian urban intersections. Validation against expert warrant determinations at Tagum City intersections remains necessary to confirm generalization to the Philippine deployment context, and the precision for the rare signalize class (F1 = 0.588, support = 6) warrants further evaluation as more labeled cases become available.

---

### 7. Para 257 — Recommendation 1 (update to reflect Toronto training)

Currently says: "The warrant classifier was trained on a dataset constructed from MUTCD-based criteria and has not yet been evaluated against warrant determinations made by a licensed traffic engineer on real intersection counts."

Replace with:

> The warrant classifier was trained on real traffic data from Toronto intersections and has not yet been evaluated against warrant determinations made by a licensed traffic engineer on Tagum City intersection counts. Future studies should collect ground-truth warrant determinations at local sites and compare these against model outputs numerically to confirm generalization from the Toronto training distribution to the Philippine deployment context.

---

## Defense answer: why synthetic if Toronto exists

Use this if the panel asks.

**Short answer:** The production model was not trained on synthetic data. The synthetic phase served three purposes that Toronto alone cannot serve: it validated the architecture before real data was available, it provides the ablation baseline that quantifies how much the switch to real data mattered, and it is the only option for Philippine-specific local warrants which have no real labeled dataset anywhere in the world.

**Key technical fact to state clearly:** The Toronto-trained model was initialized randomly and trained entirely on Toronto data. It was not fine-tuned from synthetic weights. There is no mechanism by which synthetic training contaminated the Toronto model's results.

**Full reasoning:**

1. **Chronological necessity.** The synthetic phase preceded Toronto data acquisition. At project inception there was no real labeled dataset. The synthetic generator solved the bootstrapping problem: it produces flows where the correct warrant label is computable by definition from the same rules the model learns, enabling architecture validation without real data.

2. **The ablation only exists because of the synthetic phase.** The finding — synthetic-trained AUC 0.732 vs Toronto-trained AUC 0.956 on the same real test set — is only possible because there is a synthetic baseline to compare against. Without it, the study reports a single number (0.956) with no way to quantify what was gained by using real data. The 24.5-point gap is the contribution. It answers "how much does training data quality matter?" which is a research finding in itself.

3. **Architecture validation.** The synthetic phase proved that the 1D-CNN architecture can learn the warrant classification task at all. If the model had failed on synthetic data where labels are guaranteed correct, it would have been pointless to proceed to real data. Validating on synthetic first is the responsible engineering sequence.

4. **Synthetic revealed a dead head.** The synthetic evaluation showed W-Local-2 produced zero positives (AUC undefined). This is a finding that led directly to a cleaner four-head architecture for the Toronto model. Without the synthetic phase, W-Local-2 would have been included in the Toronto model with no principled reason to remove it.

5. **Local warrants have no real dataset anywhere.** W-Local-2 and W-Local-3 are Philippine-specific. No labeled real-world dataset for these exists globally. Synthetic generation is the only evaluation option for these heads. This is not a weakness — it is the reality of working on traffic standards that predate open data.

6. **The final model's validity rests entirely on the Toronto evaluation.** The Toronto-trained model was evaluated on 93 held-out samples from 60 intersections it never saw. That evaluation is completely clean. The synthetic phase does not appear anywhere in those numbers.

**One sentence for the panel:** "The synthetic phase validated the architecture and created the ablation baseline that proves real data matters; the Toronto-trained model that ships in the system was trained from scratch on real measured traffic and evaluated on 60 held-out intersections it never saw — synthetic data is not in its pipeline at all."
