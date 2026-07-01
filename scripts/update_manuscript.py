#!/usr/bin/env python3
"""
Patches EyeGila Manuscript (2).docx with CNN warrant content.
- Replaces section 3.4 (MLP) with TemporalWarrantCNN sections + tables + charts
- Updates minor references (paras 68-69, 149-150, 171)
- Updates conclusion and recommendation paragraphs
- Does NOT touch YOLO sections (3.1, 3.2, 3.3) or Summary (3.5)
"""

import tempfile
from pathlib import Path
from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

INPUT  = Path('/Users/vincealwynn/Downloads/EyeGila Manuscript (2).docx')
OUTPUT = Path('/Users/vincealwynn/Downloads/EyeGila Manuscript (3).docx')
CHARTS = Path(tempfile.mkdtemp())


# ─── Chart generation ────────────────────────────────────────────────────────

def chart_ablation():
    metrics = ['Accuracy', 'Precision', 'Recall', 'F1-Score', 'Macro AUC', 'mAP']
    synth   = [0.720, 0.792, 0.784, 0.741, 0.732, 0.813]
    toronto = [0.884, 0.889, 0.932, 0.908, 0.956, 0.976]
    x, w = np.arange(len(metrics)), 0.35

    fig, ax = plt.subplots(figsize=(9, 5))
    b1 = ax.bar(x - w/2, synth,   w, label='Synthetic-Trained', color='#E8A838', edgecolor='white')
    b2 = ax.bar(x + w/2, toronto, w, label='Toronto-Trained',   color='#3BA55D', edgecolor='white')
    for bars in (b1, b2):
        for bar in bars:
            ax.annotate(f'{bar.get_height():.3f}',
                        xy=(bar.get_x() + bar.get_width()/2, bar.get_height()),
                        xytext=(0, 3), textcoords='offset points',
                        ha='center', va='bottom', fontsize=8)
    ax.set_xticks(x); ax.set_xticklabels(metrics)
    ax.set_ylim(0, 1.1); ax.set_ylabel('Score')
    ax.legend(); ax.yaxis.grid(True, alpha=0.3); ax.set_axisbelow(True)
    plt.tight_layout()
    p = CHARTS / 'ablation.png'; plt.savefig(p, dpi=150, bbox_inches='tight'); plt.close()
    return p


def chart_per_warrant():
    warrants  = ['W1', 'W2', 'W3', 'W4', 'Macro']
    accuracy  = [0.882, 0.925, 0.925, 0.806, 0.884]
    precision = [0.912, 0.953, 0.944, 0.746, 0.889]
    recall    = [0.925, 0.938, 0.927, 0.936, 0.932]
    f1        = [0.919, 0.946, 0.936, 0.830, 0.908]
    auc       = [0.927, 0.965, 0.980, 0.954, 0.956]
    x, w = np.arange(len(warrants)), 0.14

    fig, ax = plt.subplots(figsize=(10, 5))
    ax.bar(x - 2*w, accuracy,  w, label='Accuracy',  color='#4A90D9')
    ax.bar(x -   w, precision, w, label='Precision', color='#7ED321')
    ax.bar(x,       recall,    w, label='Recall',    color='#F5A623')
    ax.bar(x +   w, f1,        w, label='F1',        color='#D0021B')
    ax.bar(x + 2*w, auc,       w, label='AUC',       color='#9B59B6')
    ax.set_xticks(x); ax.set_xticklabels(warrants)
    ax.set_ylim(0.6, 1.08); ax.set_ylabel('Score'); ax.set_xlabel('Warrant')
    ax.legend(loc='lower right'); ax.yaxis.grid(True, alpha=0.3); ax.set_axisbelow(True)
    plt.tight_layout()
    p = CHARTS / 'per_warrant.png'; plt.savefig(p, dpi=150, bbox_inches='tight'); plt.close()
    return p


def chart_intervention():
    classes   = ['Signalize\n(n=6)', 'Road Widening\n(n=77)', 'Timing Only\n(n=10)', 'Macro\nF1']
    precision = [0.455, 1.000, 0.875, 0]
    recall    = [0.833, 0.961, 0.700, 0]
    f1        = [0.588, 0.980, 0.778, 0.782]
    x, w = np.arange(len(classes)), 0.25

    fig, ax = plt.subplots(figsize=(9, 5))
    bp = ax.bar(x - w, precision, w, label='Precision', color='#4A90D9')
    br = ax.bar(x,     recall,    w, label='Recall',    color='#F5A623')
    bf = ax.bar(x + w, f1,        w, label='F1',        color='#D0021B')
    bp[3].set_alpha(0); br[3].set_alpha(0)   # macro has no precision/recall
    for bars in (bp, br, bf):
        for i, bar in enumerate(bars):
            if bar.get_height() > 0 and bar.get_alpha() != 0:
                ax.annotate(f'{bar.get_height():.3f}',
                            xy=(bar.get_x() + bar.get_width()/2, bar.get_height()),
                            xytext=(0, 3), textcoords='offset points',
                            ha='center', va='bottom', fontsize=8)
    ax.set_xticks(x); ax.set_xticklabels(classes)
    ax.set_ylim(0, 1.15); ax.set_ylabel('Score')
    ax.legend(); ax.yaxis.grid(True, alpha=0.3); ax.set_axisbelow(True)
    plt.tight_layout()
    p = CHARTS / 'intervention.png'; plt.savefig(p, dpi=150, bbox_inches='tight'); plt.close()
    return p


# ─── Document helpers ─────────────────────────────────────────────────────────

def replace_para_content(para, new_text, bold_prefix=None):
    """Wipe all runs from para and write new_text (with optional bold prefix)."""
    p_elem = para._element
    for r in list(p_elem.findall(qn('w:r'))):
        p_elem.remove(r)
    if bold_prefix:
        run = para.add_run(bold_prefix); run.bold = True
    para.add_run(new_text)


class Inserter:
    """Inserts paragraphs, tables, and images before a reference element."""

    def __init__(self, doc, body, ref_elem):
        self.doc      = doc
        self.body     = body
        self.ref_elem = ref_elem

    def _idx(self):
        return list(self.body).index(self.ref_elem)

    def _move(self, elem):
        self.body.remove(elem)
        self.body.insert(self._idx(), elem)

    def para(self, text, style='normal', bold_prefix=None):
        p = self.doc.add_paragraph(style=style)
        if bold_prefix:
            r = p.add_run(bold_prefix); r.bold = True
        if text:
            p.add_run(text)
        self._move(p._element)
        return p

    def table(self, headers, rows):
        tbl = self.doc.add_table(rows=1 + len(rows), cols=len(headers))
        try:
            tbl.style = 'Table Grid'
        except Exception:
            pass
        hdr = tbl.rows[0].cells
        for i, h in enumerate(headers):
            hdr[i].text = h
            for run in hdr[i].paragraphs[0].runs:
                run.bold = True
        for ri, row_data in enumerate(rows):
            for ci, val in enumerate(row_data):
                tbl.rows[ri + 1].cells[ci].text = str(val)
        self._move(tbl._tbl)
        return tbl

    def image(self, path, width=5.5):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.add_run().add_picture(str(path), width=Inches(width))
        self._move(p._element)
        return p


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print('Generating charts...')
    c_ablation     = chart_ablation()
    c_per_warrant  = chart_per_warrant()
    c_intervention = chart_intervention()

    print('Loading document...')
    doc  = Document(INPUT)
    body = doc.element.body

    # Locate anchor elements
    elem_34 = elem_35 = None
    for p in doc.paragraphs:
        if '3.4 Warrant Classification' in p.text:
            elem_34 = p._element
        if '3.5 Summary of Findings' in p.text:
            elem_35 = p._element

    assert elem_34 and elem_35, 'Could not find 3.4 / 3.5 headings'

    # Remove old 3.4 content (heading through but not including 3.5)
    print('Removing old 3.4 content...')
    to_remove, collecting = [], False
    for child in list(body):
        if child is elem_34:     collecting = True
        if child is elem_35:     collecting = False
        if collecting:           to_remove.append(child)
    for elem in to_remove:
        body.remove(elem)

    ins = Inserter(doc, body, elem_35)

    # ── 3.4 heading ──────────────────────────────────────────────────────────
    print('Inserting new 3.4...')
    ins.para('3.4 Warrant Classification Model Performance', style='Heading 3')
    ins.para(
        'The traffic-signal warrant classifier was implemented as a multi-task temporal '
        'convolutional neural network (TemporalWarrantCNN) that operates directly on '
        '24-hour vehicle flow timeseries. Unlike a scalar-feature multilayer perceptron, '
        'the temporal CNN captures the shape of traffic demand across the full day, '
        'enabling it to distinguish sustained peak-hour patterns from short-duration '
        'spikes that share similar aggregate totals.'
    )

    # ── 3.4.1 Architecture ───────────────────────────────────────────────────
    ins.para('3.4.1 Model Architecture', style='Heading 4')
    ins.para(
        'The model accepts two inputs: a flow matrix of shape (5 × 96) representing '
        'five detection channels (northbound, southbound, eastbound, westbound, and '
        'pedestrian) each discretized into 96 fifteen-minute intervals; and a '
        'five-element intersection metadata vector comprising major-road lane count, '
        'minor-road lane count, posted speed (km/h), signalization status, and '
        'number of approaches.'
    )
    ins.para(
        'The architecture consists of two branches fused before the output heads. '
        'The temporal branch applies three one-dimensional convolutional blocks along '
        'the time axis, each comprising a Conv1D layer (kernel width 5, filter depths '
        '32, 64, and 128), batch normalization, ReLU activation, and max-pooling with '
        'stride 2. Adaptive average pooling produces a fixed 128-dimensional feature '
        'vector, then mapped through a fully connected layer to 128 dimensions. '
        'The metadata branch maps the five intersection features through a linear layer '
        'to 16 dimensions with ReLU activation.'
    )
    ins.para(
        'The two branches are concatenated (144 dimensions total) and passed through a '
        'shared dense layer (144 → 64, ReLU, Dropout 0.3) before splitting into two '
        'output heads. The warrant head applies a linear projection followed by sigmoid '
        'activation, producing K independent warrant probabilities — K = 6 for the '
        'synthetic-trained model (W1, W2, W3, W4, W-Local-2, W-Local-3) and K = 4 for '
        'the real-trained model (W1, W2, W3, W4). The intervention head applies a '
        'linear projection followed by softmax activation, producing a distribution '
        'over three intervention classes: signalize, road widening, and timing '
        'optimization. The model contains approximately 62,633 trainable parameters.'
    )
    ins.para(
        'Training minimizes a multi-task loss combining binary cross-entropy with '
        'logits for the warrant head and cross-entropy for the intervention head. '
        'An uncertainty-weighted formulation (Kendall et al., 2018) learns the '
        'relative contribution of each task automatically. The Adam optimizer was '
        'used with a learning rate of 0.001 and batch size of 64, with early '
        'stopping by validation loss.'
    )

    # ── 3.4.2 Synthetic baseline ─────────────────────────────────────────────
    ins.para('3.4.2 Synthetic Baseline Training', style='Heading 4')
    ins.para(
        'A synthetic training dataset was constructed prior to obtaining real traffic '
        'data. A parametric simulator generated 30 simulated intersections over 90 days, '
        'producing 24-hour flow profiles with realistic AM and PM peak structures '
        'calibrated to Tagum City priors and Philippine PCU composition. Warrant labels '
        'were generated programmatically by applying the MUTCD and local warrant '
        'evaluators to each simulated day, ensuring exact consistency between the labels '
        'and the rules the model approximates. The dataset was split '
        'intersection-stratified into 21 training, 4 validation, and 5 test intersections.'
    )
    ins.para(
        'Table 3.3 reports per-warrant performance on the 900-sample synthetic test set. '
        'The model achieved a macro ROC-AUC of 0.977 across the active warrant heads. '
        'Two heads were identified as inactive or unreliable: W-Local-2 produced zero '
        'positive predictions (AUC undefined), and W4 achieved high AUC (0.956) but '
        'near-zero F1 (0.044), a consequence of extreme class imbalance at 4.9% positive '
        'rate in the synthetic distribution. These findings informed the head reduction '
        'applied during real-data retraining.'
    )
    ins.para(
        'Table 3.3. Per-warrant performance of the synthetic-trained TemporalWarrantCNN '
        'on the synthetic test set (900 samples, best checkpoint).'
    )
    ins.table(
        ['Warrant', 'AUC', 'F1'],
        [
            ['W1 – Minimum Vehicular Volume',            '0.984', '0.809'],
            ['W2 – Interruption of Continuous Traffic', '0.977', '0.826'],
            ['W3 – Peak Hour',                          '0.989', '0.797'],
            ['W4 – Pedestrian Volume',                  '0.956', '0.044'],
            ['W-Local-2',                                    'N/A',   '0.000'],
            ['W-Local-3',                                    '0.999', '0.936'],
            ['Macro (active heads, excl. W-Local-2)',         '0.977', '0.838'],
        ]
    )
    ins.para(
        'Note. AUC = area under the ROC curve. F1 computed at a 0.5 decision threshold '
        'on sigmoid outputs. W-Local-2 AUC is undefined due to zero positive predictions '
        'in the test set.'
    )

    # ── 3.4.3 Ablation ───────────────────────────────────────────────────────
    ins.para('3.4.3 Real-Data Retraining and Distribution Shift Ablation', style='Heading 4')
    ins.para(
        'The synthetic training regime introduces a risk of distribution shift: a model '
        'trained on simulated flows may not generalize to real measured traffic. To '
        'quantify and address this, the synthetic-trained model was evaluated on a '
        'held-out real-data test set and subsequently retrained on real traffic data.'
    )
    ins.para(
        'The City of Toronto Open Data Multimodal Turning Movement Count (TMC) dataset '
        'was selected as the real training source. It provides 15-minute per-approach '
        'vehicle and pedestrian counts for 617 unique intersections from 2020 to 2026, '
        'available as a single direct-download CSV under the Open Government Licence – '
        'Toronto. It is the only publicly available dataset providing real per-direction '
        'pedestrian counts at 15-minute granularity without institutional access '
        'requirements. Warrant labels were applied using the same MUTCD evaluators used '
        'during synthetic training. Toronto TMC studies cover 8 to 14 daytime hours; '
        'slots outside the study window were zero-padded. Because zero-padded overnight '
        'hours carry no discriminative signal for W-Local-3 (a low-volume nighttime '
        'criterion), that head was excluded from the real-trained model. W-Local-2 was '
        'also excluded after the synthetic evaluation confirmed zero positive predictions. '
        'The real-trained model therefore predicts four warrant heads: W1, W2, W3, and '
        'W4. The dataset was split intersection-stratified into 691 training, 89 '
        'validation, and 93 test samples; the best checkpoint was selected at epoch 47 '
        'by validation loss.',
        bold_prefix='Dataset. '
    )
    ins.para(
        'Table 3.4 compares both models on the same 93-sample held-out real test set. '
        'The synthetic-trained model produced a macro AUC of 0.732 on real flows — a '
        '24.5-point drop from its 0.977 performance on synthetic data. Retraining on '
        'Toronto flows recovered macro AUC to 0.956, closing the gap to 2.1 AUC points. '
        'All classification metrics improved substantially, as shown in Figure 3.7.',
        bold_prefix='Ablation. '
    )
    ins.para(
        'Table 3.4. Distribution shift ablation: synthetic-trained vs. Toronto-trained '
        'TemporalWarrantCNN on the held-out real test set (93 samples, four MUTCD '
        'warrant heads).'
    )
    ins.table(
        ['Metric', 'Synthetic-Trained', 'Toronto-Trained', 'Delta'],
        [
            ['Accuracy',   '0.720', '0.884', '+0.164'],
            ['Precision',  '0.792', '0.889', '+0.096'],
            ['Recall',     '0.784', '0.932', '+0.148'],
            ['F1-Score',   '0.741', '0.908', '+0.166'],
            ['Macro AUC',  '0.732', '0.956', '+0.224'],
            ['mAP',        '0.813', '0.976', '+0.163'],
        ]
    )
    ins.para(
        'Note. All metrics are macro-averaged across W1, W2, W3, and W4. '
        'mAP = mean average precision. Evaluated on the same 93-sample held-out real test set.'
    )
    ins.image(c_ablation)
    ins.para(
        'Figure 3.7. Distribution shift ablation: synthetic-trained (amber) vs. '
        'Toronto-trained (green) TemporalWarrantCNN evaluated on the held-out real '
        'test set (93 samples, four MUTCD warrant heads).'
    )

    ins.para(
        'Table 3.5 and Figure 3.8 report per-warrant performance of the Toronto-trained '
        'model on the real test set.'
    )
    ins.para(
        'Table 3.5. Per-warrant classification performance of the Toronto-trained '
        'TemporalWarrantCNN on the held-out real test set (93 samples).'
    )
    ins.table(
        ['Warrant', 'Accuracy', 'Precision', 'Recall', 'F1', 'AUC', 'AP'],
        [
            ['W1 – Minimum Vehicular Volume',            '0.882', '0.912', '0.925', '0.919', '0.927', '0.970'],
            ['W2 – Interruption of Continuous Traffic', '0.925', '0.953', '0.938', '0.946', '0.965', '0.988'],
            ['W3 – Peak Hour',                          '0.925', '0.944', '0.927', '0.936', '0.980', '0.986'],
            ['W4 – Pedestrian Volume',                  '0.806', '0.746', '0.936', '0.830', '0.954', '0.959'],
            ['Macro',                                         '0.884', '0.889', '0.932', '0.908', '0.956', '0.976'],
        ]
    )
    ins.para(
        'Note. AP = average precision (area under the precision-recall curve). '
        'Metrics computed at a 0.5 decision threshold on sigmoid outputs, except '
        'AUC and AP which use raw probabilities.'
    )
    ins.image(c_per_warrant)
    ins.para(
        'Figure 3.8. Per-warrant classification performance of the Toronto-trained '
        'TemporalWarrantCNN on the held-out real test set (93 samples).'
    )

    # ── 3.4.4 Intervention ───────────────────────────────────────────────────
    ins.para('3.4.4 Intervention Classification', style='Heading 4')
    ins.para(
        'In addition to warrant prediction, the model outputs a three-class intervention '
        'recommendation: signalize (install new signals), road widening (add approach '
        'lanes), or timing optimization (adjust existing signal splits). Table 3.6 '
        'reports per-class performance of the Toronto-trained model on the real test set. '
        'The road widening class, constituting 83% of the test set, was classified with '
        'near-perfect precision and recall. Timing only recall improved from 0.200 under '
        'the synthetic-trained model to 0.700 with retraining — the most pronounced gain '
        'from using real data. Signalize F1 (0.588) was lowest owing to a support of '
        'only six samples, making precision sensitive to individual predictions. Inference '
        'throughput on CPU is 5,109 samples per second (0.196 ms/sample). Figure 3.9 '
        'visualizes the per-class results.'
    )
    ins.para(
        'Table 3.6. Intervention classification performance of the Toronto-trained '
        'model on the real test set (93 samples, overall accuracy 0.925).'
    )
    ins.table(
        ['Intervention Class', 'Precision', 'Recall', 'F1', 'Support'],
        [
            ['Signalize',           '0.455', '0.833', '0.588', '6'],
            ['Road Widening',       '1.000', '0.961', '0.980', '77'],
            ['Timing Optimization', '0.875', '0.700', '0.778', '10'],
            ['Macro',               '—',   '—',   '0.782', '93'],
        ]
    )
    ins.image(c_intervention)
    ins.para(
        'Figure 3.9. Intervention classification performance of the Toronto-trained '
        'TemporalWarrantCNN on the real test set (93 samples, overall accuracy 0.925).'
    )

    # ── Patch small references ────────────────────────────────────────────────
    print('Patching minor references...')

    patches = [
        (
            'Outputs confidence scores for Warrant 1, 2, and 4, and an overall signal recommendation per intersection.',
            'Outputs confidence scores for Warrant 1, 2, 3, and 4, and an intervention recommendation '
            '(signalize, road widening, or timing optimization) per intersection.',
            None
        ),
        (
            'Warrant recommendations page showing Warrant 1, 2, and 4 confidence scores and overall recommendation per intersection.',
            'Warrant recommendations page showing Warrant 1, 2, 3, and 4 confidence scores and intervention '
            'recommendation (signalize, road widening, or timing optimization) per intersection.',
            None
        ),
        (
            # Conclusion third finding
            'Third, the warrant-classification model distinguished Warrant 1, Warrant 2, and Warrant 4 '
            'cases with a high overall F1-score on the held-out test set, showing that accumulated traffic '
            'counts can be mapped to MUTCD-based signal warrants.',
            'Third, the temporal CNN warrant classifier achieved a macro F1 of 0.908 and macro AUC of 0.956 '
            'across four MUTCD warrant heads on a held-out real test set of 93 samples drawn from 60 Toronto '
            'intersections, demonstrating that accumulated 24-hour traffic counts can be reliably mapped to '
            'MUTCD-based signal warrant determinations. A distribution shift ablation showed that retraining '
            'on real traffic data reduced a 24.5-point AUC gap (synthetic-trained: 0.732) to 2.1 points.',
            None
        ),
        (
            # Conclusion limitation sentence
            'The warrant classifier was evaluated on a dataset constructed from MUTCD-based criteria '
            'grounded in field observations and traffic engineering research. Validation against expert '
            'warrant determinations on real intersection counts remains necessary to confirm that the '
            "model's performance transfers to operational conditions, and its precision for the rare "
            'Warrant 2 class was weak.',
            'The warrant classifier was trained and evaluated on the Toronto Open Data TMC dataset, '
            'which covers Canadian urban intersections. Validation against expert warrant determinations '
            'at Tagum City intersections remains necessary to confirm generalization to the Philippine '
            'deployment context, and the precision for the rare signalize intervention class '
            '(F1 = 0.588, support = 6) warrants further evaluation as more labeled '
            'cases become available.',
            None
        ),
        (
            # Recommendation 1 sentence
            'The warrant classifier was trained on a dataset constructed from MUTCD-based criteria and '
            'has not yet been evaluated against warrant determinations made by a licensed traffic engineer '
            'on real intersection counts. Future studies should collect ground-truth warrant determinations '
            'at Tagum City sites and compare these against model outputs numerically. Decision thresholds '
            'for low-frequency warrants, particularly Warrant 2, should be recalibrated on this '
            'field-annotated data to improve precision before any operational use.',
            'The warrant classifier was trained on real traffic data from Toronto intersections and has '
            'not yet been evaluated against warrant determinations made by a licensed traffic engineer on '
            'Tagum City intersection counts. Future studies should collect ground-truth warrant '
            'determinations at local sites and compare model outputs numerically to confirm generalization '
            'from the Toronto training distribution to the Philippine deployment context.',
            None
        ),
    ]

    for old_snippet, new_text, bold_prefix in patches:
        # Try exact match first, then partial key match
        key = old_snippet[:60]
        for p in doc.paragraphs:
            if key in p.text:
                full = p.text
                if old_snippet in full:
                    replace_para_content(p, new_text.strip(), bold_prefix)
                else:
                    # old_snippet spans the full paragraph - just replace all
                    replace_para_content(p, full.replace(old_snippet, new_text).strip(), bold_prefix)
                break

    # MLP description para (149) — replace + delete the follow-up line (150)
    mlp_para = next_para = None
    for i, p in enumerate(doc.paragraphs):
        if 'A Multilayer Perceptron (5 inputs, 64-32-4 neurons' in p.text:
            mlp_para = p
        if mlp_para and 'Evaluates peak hour volumes from the continuous aggregate' in p.text:
            next_para = p
            break

    if mlp_para:
        replace_para_content(
            mlp_para,
            'A multi-task temporal convolutional neural network (TemporalWarrantCNN) evaluates a '
            '24-hour vehicle flow matrix of shape (5 × 96) — five approach channels '
            '(N, S, E, W, pedestrian) discretized into 96 fifteen-minute slots — together '
            'with a five-feature intersection metadata vector. The model outputs per-warrant '
            'confidence scores for Warrant 1, 2, 3, and 4 via sigmoid activation, and an '
            'intervention class (signalize, road widening, or timing optimization) via softmax. '
            'The model was trained on real per-approach traffic counts from the City of Toronto '
            'Open Data Multimodal Turning Movement Count dataset and evaluated on a held-out set '
            'of 93 samples from 60 unseen intersections.'
        )
    if next_para:
        next_para._element.getparent().remove(next_para._element)

    # ── Save ─────────────────────────────────────────────────────────────────
    print(f'Saving to {OUTPUT}...')
    doc.save(OUTPUT)
    print('Done.')


if __name__ == '__main__':
    main()
