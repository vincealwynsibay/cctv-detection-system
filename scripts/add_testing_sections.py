"""
Inserts Alpha, Beta, Usability, and Functionality Suitability testing sections
before the Summary of Findings heading in EyeGila Manuscript (3).docx.
Renames 3.5 Summary of Findings -> 3.9 Summary of Findings.
Saves output as EyeGila Manuscript (4).docx.
"""

from docx import Document
from docx.oxml.ns import qn
from lxml import etree
import copy

INPUT  = '/Users/vincealwynn/Downloads/EyeGila Manuscript (3).docx'
OUTPUT = '/Users/vincealwynn/Downloads/EyeGila Manuscript (4).docx'

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

doc = Document(INPUT)
body = doc.element.body

# ── 1. Find and rename the 3.5 Summary heading directly in body children ─────

ref_elem = None
ref_idx = None
for i, child in enumerate(body):
    if child.tag == f'{{{W}}}p':
        texts = [t.text or '' for t in child.iter(f'{{{W}}}t')]
        full = ''.join(texts)
        if '3.5' in full and 'Summary' in full:
            ref_elem = child
            ref_idx = i
            break

assert ref_elem is not None, "Could not find 3.5 Summary of Findings in body"

# Rename all text runs in that heading
for t_elem in ref_elem.iter(f'{{{W}}}t'):
    if t_elem.text:
        t_elem.text = t_elem.text.replace('3.5', '3.9')

print(f"Found 3.9 Summary at body child index {ref_idx}")

# ── 2. Build new XML elements ─────────────────────────────────────────────────

USABLE_W = 9360  # twips (page 12240 - left 1440 - right 1440)

def make_heading(text, level, style_map=None):
    """Create a <w:p> with Heading N style."""
    style_names = {3: 'Heading3', 4: 'Heading4'}
    style_id = style_names.get(level, 'Heading3')

    p = etree.Element(f'{{{W}}}p')
    pPr = etree.SubElement(p, f'{{{W}}}pPr')
    pStyle = etree.SubElement(pPr, f'{{{W}}}pStyle')
    pStyle.set(f'{{{W}}}val', style_id)
    r = etree.SubElement(p, f'{{{W}}}r')
    t = etree.SubElement(r, f'{{{W}}}t')
    t.text = text
    t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    return p


def make_para(text, style='normal'):
    """Create a <w:p> with normal style."""
    p = etree.Element(f'{{{W}}}p')
    pPr = etree.SubElement(p, f'{{{W}}}pPr')
    pStyle = etree.SubElement(pPr, f'{{{W}}}pStyle')
    pStyle.set(f'{{{W}}}val', style)
    if text:
        r = etree.SubElement(p, f'{{{W}}}r')
        t = etree.SubElement(r, f'{{{W}}}t')
        t.text = text
        t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    return p


def make_table(headers, rows, col_widths=None, bold_last=True):
    """
    Create a full-width <w:tbl> with borders.
    col_widths: list of twip widths for each column (must sum to USABLE_W).
    If None, distribute evenly.
    """
    n_cols = len(headers)
    if col_widths is None:
        w = USABLE_W // n_cols
        col_widths = [w] * n_cols
        col_widths[-1] = USABLE_W - sum(col_widths[:-1])

    tbl = etree.Element(f'{{{W}}}tbl')

    # Table properties
    tblPr = etree.SubElement(tbl, f'{{{W}}}tblPr')
    tblStyle = etree.SubElement(tblPr, f'{{{W}}}tblStyle')
    tblStyle.set(f'{{{W}}}val', 'TableGrid')
    tblW_elem = etree.SubElement(tblPr, f'{{{W}}}tblW')
    tblW_elem.set(f'{{{W}}}w', str(USABLE_W))
    tblW_elem.set(f'{{{W}}}type', 'dxa')
    tblBorders = etree.SubElement(tblPr, f'{{{W}}}tblBorders')
    for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        b_elem = etree.SubElement(tblBorders, f'{{{W}}}{side}')
        b_elem.set(f'{{{W}}}val', 'single')
        b_elem.set(f'{{{W}}}sz', '4')
        b_elem.set(f'{{{W}}}space', '0')
        b_elem.set(f'{{{W}}}color', '000000')

    # Grid columns
    tblGrid = etree.SubElement(tbl, f'{{{W}}}tblGrid')
    for w in col_widths:
        gc = etree.SubElement(tblGrid, f'{{{W}}}gridCol')
        gc.set(f'{{{W}}}w', str(w))

    def make_cell(text, width, bold=False):
        tc = etree.Element(f'{{{W}}}tc')
        tcPr = etree.SubElement(tc, f'{{{W}}}tcPr')
        tcW_e = etree.SubElement(tcPr, f'{{{W}}}tcW')
        tcW_e.set(f'{{{W}}}w', str(width))
        tcW_e.set(f'{{{W}}}type', 'dxa')
        p = etree.SubElement(tc, f'{{{W}}}p')
        pPr = etree.SubElement(p, f'{{{W}}}pPr')
        pStyle = etree.SubElement(pPr, f'{{{W}}}pStyle')
        pStyle.set(f'{{{W}}}val', 'normal')
        r = etree.SubElement(p, f'{{{W}}}r')
        if bold:
            rPr = etree.SubElement(r, f'{{{W}}}rPr')
            etree.SubElement(rPr, f'{{{W}}}b')
        t_e = etree.SubElement(r, f'{{{W}}}t')
        t_e.text = str(text)
        t_e.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        return tc

    def make_row(cells_text, col_widths, bold=False):
        tr = etree.Element(f'{{{W}}}tr')
        for text, w in zip(cells_text, col_widths):
            tr.append(make_cell(text, w, bold=bold))
        return tr

    # Header row
    tbl.append(make_row(headers, col_widths, bold=True))

    # Data rows
    for i, row in enumerate(rows):
        is_last = (i == len(rows) - 1)
        tbl.append(make_row(row, col_widths, bold=(bold_last and is_last)))

    return tbl


# ── 3. Build all new elements in order ───────────────────────────────────────

new_elems = []

def h(text, level=3):
    new_elems.append(make_heading(text, level))

def p(text):
    new_elems.append(make_para(text))

def blank():
    new_elems.append(make_para(''))

def table_cap(text):
    new_elems.append(make_para(text))

def table(headers, rows, col_widths=None, bold_last=True):
    new_elems.append(make_table(headers, rows, col_widths, bold_last))


# ── 3.5 Alpha Testing ─────────────────────────────────────────────────────────
h('3.5 Alpha Testing')
p('Alpha testing was conducted with four reviewers drawn from the thesis panel and '
  'academic advisers. Each reviewer evaluated the system against eight ISO/IEC 9126 '
  'software quality criteria using a 10-point rating scale. Criteria were weighted '
  'according to their relative importance: Product Quality and Functional Testing each '
  'carried a 20% weight, while the remaining six criteria (Functionality, Reliability, '
  'Usability, Efficiency, Maintainability, and Portability) each carried a 10% weight. '
  'The weighted scores for each criterion sum to a maximum of 100.')

table_cap('Table 3.9. Alpha Testing Results (n = 4 reviewers, 10-point scale).')
# col widths: Criterion(wide), Weight, Score, %, Interpretation
table(
    headers=['Criterion', 'Weight', 'Weighted Score', 'Percentage', 'Interpretation'],
    rows=[
        ('Efficiency',         '10%',  '9.50', '95.00%', 'Excellent'),
        ('Maintainability',    '10%',  '9.50', '95.00%', 'Excellent'),
        ('Product Quality',    '20%', '18.75', '93.75%', 'Excellent'),
        ('Functionality',      '10%',  '9.25', '92.50%', 'Excellent'),
        ('Functional Testing', '20%', '18.00', '90.00%', 'Excellent'),
        ('Reliability',        '10%',  '9.00', '90.00%', 'Excellent'),
        ('Usability',          '10%',  '9.00', '90.00%', 'Excellent'),
        ('Portability',        '10%',  '8.75', '87.50%', 'Very Good'),
        ('Overall',           '100%', '91.75', '91.75%', 'Excellent'),
    ],
    col_widths=[2800, 800, 1500, 1500, 2000],
)

p('The system scored 91.75 out of 100 in alpha testing, which falls in the Excellent range. '
  'All eight criteria scored at or above 87.50%.')
p('Efficiency and Maintainability tied for the highest scores (95.00%, Excellent). Reviewers '
  'rated the system highly on response time under normal load and on how easily its codebase '
  'can be modified, with all four reviewers giving near-full marks on both. Product Quality '
  'followed at 93.75% (Excellent); the Reliability sub-criterion scored well, though one '
  'reviewer gave a lower mark on Robustness, noting that the system\'s feedback under atypical '
  'inputs could be more informative. Functionality scored 92.50% (Excellent), with reviewers '
  'confirming that the system performs the functions it is specified to perform. Functional '
  'Testing, Reliability, and Usability each scored 90.00% (Excellent); reviewers found that '
  'the system handles valid and invalid data correctly, operates consistently under expected '
  'conditions, and is understandable to a new user without significant training. Portability '
  'received the lowest score at 87.50% (Very Good), as running the system outside the '
  'development environment requires documented configuration steps that are not yet bundled '
  'with the application.')
p('The results confirm the system meets its functional and non-functional requirements '
  'across all evaluated quality dimensions.')

# ── 3.6 Beta Testing ──────────────────────────────────────────────────────────
h('3.6 Beta Testing')
p('Beta testing engaged ten respondents representing the intended end-user population of '
  'traffic engineers and local government personnel. Respondents evaluated the system on '
  'the same eight ISO/IEC 9126 criteria using a five-point Likert scale, with items grouped '
  'under each criterion. Scores were normalized to the same 100-point weighted framework as '
  'alpha testing to allow direct comparison.')

table_cap('Table 3.10. Beta Testing Results (n = 10 respondents, 5-point Likert scale).')
table(
    headers=['Criterion', 'Weight', 'Weighted Score', 'Percentage', 'Interpretation'],
    rows=[
        ('Functionality',      '10%',  '9.00', '90.00%', 'Excellent'),
        ('Reliability',        '10%',  '8.90', '89.00%', 'Very Good'),
        ('Maintainability',    '10%',  '8.90', '89.00%', 'Very Good'),
        ('Portability',        '10%',  '8.90', '89.00%', 'Very Good'),
        ('Functional Testing', '20%', '17.60', '88.00%', 'Very Good'),
        ('Usability',          '10%',  '8.70', '87.00%', 'Very Good'),
        ('Efficiency',         '10%',  '8.70', '87.00%', 'Very Good'),
        ('Product Quality',    '20%', '16.30', '81.50%', 'Very Good'),
        ('Overall',           '100%', '87.00', '87.00%', 'Very Good'),
    ],
    col_widths=[2800, 800, 1500, 1500, 2000],
)

p('Ten end-user respondents scored the system 87.00 out of 100 in beta testing, which falls '
  'in the Very Good range. No criterion scored below 81.50%.')
p('Functionality was the highest-rated criterion (90.00%, Excellent); respondents confirmed '
  'the system performs the functions they expected for intersection monitoring and warrant '
  'evaluation. Reliability, Maintainability, and Portability each scored 89.00% (Very Good): '
  'respondents reported the system behaved consistently across sessions, that settings and '
  'configurations remained predictable between uses, and that it ran without issue across the '
  'browser environments they tested. Functional Testing scored 88.00% (Very Good), with '
  'respondents confirming that valid inputs produced correct outputs and that invalid inputs '
  'produced appropriate error messages. Usability and Efficiency each scored 87.00% (Very '
  'Good); the primary concern raised under both criteria was the number of steps required to '
  'complete common tasks and the time spent locating controls within the interface. Product '
  'Quality received the lowest score (81.50%, Very Good), driven by the Robustness '
  'sub-criterion; several respondents noted that the system\'s response to unusual input '
  'sequences could be more descriptive, a concern consistent with the alpha reviewer feedback '
  'on the same sub-criterion.')
p('The beta results show the system functions as intended with its target user group under '
  'near-production conditions.')

# ── 3.7 Usability Testing ─────────────────────────────────────────────────────
h('3.7 Usability Testing')
p('Usability testing was administered to ten respondents using the Usefulness, Satisfaction, '
  'and Ease of Use (USE) questionnaire, which groups 30 items across four dimensions: '
  'Usefulness (8 items), Ease of Use (11 items), Ease of Learning (4 items), and Satisfaction '
  '(7 items). Each item was rated on a five-point Likert scale (1 = Strongly Disagree, '
  '5 = Strongly Agree). Dimension scores represent the mean of all item averages within that '
  'dimension; the overall score is the mean across the four dimension averages, expressed as '
  'a percentage of the five-point maximum.')

table_cap('Table 3.11. Usability Testing Results by Dimension (n = 10 respondents, 5-point Likert scale).')
table(
    headers=['Dimension', 'No. of Items', 'Mean Score', 'Percentage', 'Interpretation'],
    rows=[
        ('Satisfaction',     '7',  '4.66', '93.14%', 'Excellent'),
        ('Ease of Learning', '4',  '4.58', '91.50%', 'Excellent'),
        ('Usefulness',       '8',  '4.55', '91.00%', 'Excellent'),
        ('Ease of Use',     '11',  '4.40', '88.00%', 'Very Good'),
        ('Overall',         '30',  '4.55', '90.95%', 'Excellent'),
    ],
    col_widths=[2500, 1200, 1500, 1500, 2000],
)

p('The system scored 90.95% overall on the USE questionnaire, which falls in the Excellent '
  'range. All four dimensions scored above 88%. Satisfaction was the highest-rated dimension '
  '(4.66, 93.14%, Excellent), with items on overall satisfaction and willingness to recommend '
  'drawing the strongest agreement from respondents. Ease of Learning scored 4.58 (91.50%, '
  'Excellent); respondents reported picking up the system quickly and being able to use it '
  'again without relearning it, which is relevant given that local government users may '
  'interact with the system infrequently. Usefulness scored 4.55 (91.00%, Excellent), and '
  'respondents rated the system as effective and time-saving for intersection monitoring and '
  'warrant recommendation tasks. Ease of Use was the lowest-scoring dimension (4.40, 88.00%, '
  'Very Good), with step minimization and interface flexibility items rating below the '
  'dimension average. This result is consistent with the interface feedback collected in beta '
  'testing and points to the same area for future refinement.')

# ── 3.8 Functionality Suitability Testing ────────────────────────────────────
h('3.8 Functionality Suitability Testing')
p('Functionality suitability testing evaluated whether each intended system function is '
  'present and operates correctly. Ten respondents independently verified 20 functional test '
  'cases using a binary Yes/No response, where Yes indicates that the tested function was '
  'observed to work as specified. The test cases covered authentication, navigation, data '
  'display, reporting, and security functions.')

table_cap('Table 3.12. Functionality Suitability Testing Results (n = 10 respondents, 20 test cases).')
table(
    headers=['No.', 'Test Case', 'YES', 'NO'],
    rows=[
        ('1',  'The login function works as intended.', '10', '0'),
        ('2',  'The system shows an appropriate message when invalid credentials are entered.', '10', '0'),
        ('3',  'The system protects pages that require authentication.', '10', '0'),
        ('4',  'The sidebar navigation links are present and accessible.', '10', '0'),
        ('5',  'Navigating between the main pages of the system works correctly.', '10', '0'),
        ('6',  'The main page of the system loads and shows the expected content.', '10', '0'),
        ('7',  'The dashboard displays without any visible errors.', '10', '0'),
        ('8',  'Setup and add controls are reachable from the main page.', '10', '0'),
        ('9',  'The intersection detail page can be opened and viewed.', '10', '0'),
        ('10', 'The signal timing page loads and displays its information.', '10', '0'),
        ('11', 'The reports page loads and displays its heading and content.', '10', '0'),
        ('12', 'The reports page runs without any visible errors.', '10', '0'),
        ('13', 'The videos page loads and is accessible to the user.', '10', '0'),
        ('14', 'The users page loads and is accessible to the user.', '10', '0'),
        ('15', 'The intersection report page loads and is accessible to the user.', '10', '0'),
        ('16', 'The system responds when the server health is checked.', '10', '0'),
        ('17', 'Unauthorized requests to the system are rejected as expected.', '10', '0'),
        ('18', 'Invalid login attempts are rejected by the system.', '10', '0'),
        ('19', 'The system remains stable when the window is resized.', '10', '0'),
        ('20', 'The logout function correctly returns the user to the login page.', '10', '0'),
        ('Total', '', '200', '0'),
        ('Overall', '', '100.00%', '0.00%'),
    ],
    col_widths=[500, 7260, 900, 700],
    bold_last=True,
)

p('All ten respondents confirmed Yes for every one of the 20 test cases, giving the system '
  'a functionality suitability score of 100%. Authentication cases (items 1, 2, 3, and 18) '
  'passed unanimously: login, error messaging on invalid credentials, and route protection '
  'all operated as specified. Navigation and page loading (items 4 to 15) were all confirmed, '
  'with every major page accessible and error-free. Security checks (items 16 and 17) passed '
  'as well; the health endpoint responded and unauthorized requests were rejected. The '
  'browser-resize case (item 19) passed for all respondents. No respondent recorded a No on '
  'any item, confirming that all implemented functions were present and operated as intended '
  'within the test environment.')

# ── 4. Insert all new elements before the ref_idx position ───────────────────
# Insert in REVERSE order so the first element ends up at ref_idx
for elem in reversed(new_elems):
    body.insert(ref_idx, elem)

print(f"Inserted {len(new_elems)} elements before body child {ref_idx}")

# ── 5. Save ───────────────────────────────────────────────────────────────────
doc.save(OUTPUT)
print(f"Saved: {OUTPUT}")

# Verify heading order
doc2 = Document(OUTPUT)
for p_elem in doc2.paragraphs:
    if p_elem.style.name in ('Heading 3', 'Heading 2') and any(
        x in p_elem.text for x in ['3.5 ', '3.6 ', '3.7 ', '3.8 ', '3.9 ', '4. ']
    ):
        print(f"  {p_elem.style.name}: {p_elem.text[:70]}")
