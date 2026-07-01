# Results and Discussion — System Testing Sections

Copy-paste ready text for the manuscript. Tables and paragraphs are written in thesis academic style. Insert these after the model performance sections (after 3.4 or wherever the testing sections belong in your chapter structure).

---

## Interpretation Scale Reference

| Percentage Range | Qualitative Description |
|---|---|
| 90.00 -- 100.00% | Excellent |
| 80.00 -- 89.99% | Very Good |
| 70.00 -- 79.99% | Good |
| 60.00 -- 69.99% | Fair |
| Below 60.00% | Poor |

For Usability (Likert 1--5):

| Mean Range | Qualitative Description |
|---|---|
| 4.51 -- 5.00 | Strongly Agree / Excellent |
| 3.51 -- 4.50 | Agree / Very Good |
| 2.51 -- 3.50 | Neutral / Good |
| 1.51 -- 2.50 | Disagree / Fair |
| 1.00 -- 1.50 | Strongly Disagree / Poor |

---

## 3.X Alpha Testing

Alpha testing was conducted with four reviewers drawn from the thesis panel and academic advisers. Each reviewer evaluated the system against eight ISO/IEC 9126 software quality criteria using a 10-point rating scale. Criteria were weighted according to their relative importance: Product Quality and Functional Testing each carried a 20% weight, while the remaining six criteria (Functionality, Reliability, Usability, Efficiency, Maintainability, and Portability) each carried a 10% weight. The weighted scores for each criterion sum to a maximum of 100.

**Table X.** Alpha Testing Results (n = 4 reviewers, 10-point scale).

| Criterion | Weight | Weighted Score | Percentage | Interpretation |
|---|---|---|---|---|
| Efficiency | 10% | 9.50 | 95.00% | Excellent |
| Maintainability | 10% | 9.50 | 95.00% | Excellent |
| Product Quality | 20% | 18.75 | 93.75% | Excellent |
| Functionality | 10% | 9.25 | 92.50% | Excellent |
| Functional Testing | 20% | 18.00 | 90.00% | Excellent |
| Reliability | 10% | 9.00 | 90.00% | Excellent |
| Usability | 10% | 9.00 | 90.00% | Excellent |
| Portability | 10% | 8.75 | 87.50% | Very Good |
| **Overall** | **100%** | **91.75** | **91.75%** | **Excellent** |

The system scored 91.75 out of 100 in alpha testing, which falls in the Excellent range. All eight criteria scored at or above 87.50%.

Efficiency and Maintainability tied for the highest scores (95.00%, Excellent). Reviewers rated the system highly on response time under normal load and on how easily its codebase can be modified, with all four reviewers giving near-full marks on both. Product Quality followed at 93.75% (Excellent); the Reliability sub-criterion scored well, though one reviewer gave a lower mark on Robustness, noting that the system's feedback under atypical inputs could be more informative. Functionality scored 92.50% (Excellent), with reviewers confirming that the system performs the functions it is specified to perform. Functional Testing, Reliability, and Usability each scored 90.00% (Excellent); reviewers found that the system handles valid and invalid data correctly, operates consistently under expected conditions, and is understandable to a new user without significant training. Portability received the lowest score at 87.50% (Very Good), as running the system outside the development environment requires documented configuration steps that are not yet bundled with the application.

The results confirm the system meets its functional and non-functional requirements across all evaluated quality dimensions.

---

## 3.X+1 Beta Testing

Beta testing engaged ten respondents representing the intended end-user population of traffic engineers and local government personnel. Respondents evaluated the system on the same eight ISO/IEC 9126 criteria using a five-point Likert scale, with items grouped under each criterion. Scores were normalized to the same 100-point weighted framework as alpha testing to allow direct comparison.

**Table X+1.** Beta Testing Results (n = 10 respondents, 5-point Likert scale).

| Criterion | Weight | Weighted Score | Percentage | Interpretation |
|---|---|---|---|---|
| Functionality | 10% | 9.00 | 90.00% | Excellent |
| Reliability | 10% | 8.90 | 89.00% | Very Good |
| Maintainability | 10% | 8.90 | 89.00% | Very Good |
| Portability | 10% | 8.90 | 89.00% | Very Good |
| Functional Testing | 20% | 17.60 | 88.00% | Very Good |
| Usability | 10% | 8.70 | 87.00% | Very Good |
| Efficiency | 10% | 8.70 | 87.00% | Very Good |
| Product Quality | 20% | 16.30 | 81.50% | Very Good |
| **Overall** | **100%** | **87.00** | **87.00%** | **Very Good** |

Ten end-user respondents scored the system 87.00 out of 100 in beta testing, which falls in the Very Good range. No criterion scored below 81.50%.

Functionality was the highest-rated criterion (90.00%, Excellent); respondents confirmed the system performs the functions they expected for intersection monitoring and warrant evaluation. Reliability, Maintainability, and Portability each scored 89.00% (Very Good): respondents reported the system behaved consistently across sessions, that settings and configurations remained predictable between uses, and that it ran without issue across the browser environments they tested. Functional Testing scored 88.00% (Very Good), with respondents confirming that valid inputs produced correct outputs and that invalid inputs produced appropriate error messages. Usability and Efficiency each scored 87.00% (Very Good); the primary concern raised under both criteria was the number of steps required to complete common tasks and the time spent locating controls within the interface. Product Quality received the lowest score (81.50%, Very Good), driven by the Robustness sub-criterion; several respondents noted that the system's response to unusual input sequences could be more descriptive, a concern consistent with the alpha reviewer feedback on the same sub-criterion.

The beta results show the system functions as intended with its target user group under near-production conditions.

---

## 3.X+2 Usability Testing

Usability testing was administered to ten respondents using the Usefulness, Satisfaction, and Ease of Use (USE) questionnaire, which groups 30 items across four dimensions: Usefulness (8 items), Ease of Use (11 items), Ease of Learning (4 items), and Satisfaction (7 items). Each item was rated on a five-point Likert scale (1 = Strongly Disagree, 5 = Strongly Agree). Dimension scores represent the mean of all item averages within that dimension; the overall score is the mean across the four dimension averages, expressed as a percentage of the five-point maximum.

**Table X+2.** Usability Testing Results by Dimension (n = 10 respondents, 5-point Likert scale).

| Dimension | No. of Items | Mean Score | Percentage | Interpretation |
|---|---|---|---|---|
| Satisfaction | 7 | 4.66 | 93.14% | Excellent |
| Ease of Learning | 4 | 4.58 | 91.50% | Excellent |
| Usefulness | 8 | 4.55 | 91.00% | Excellent |
| Ease of Use | 11 | 4.40 | 88.00% | Very Good |
| **Overall** | **30** | **4.55** | **90.95%** | **Excellent** |

The system scored 90.95% overall on the USE questionnaire, which falls in the Excellent range. All four dimensions scored above 88%. Satisfaction was the highest-rated dimension (4.66, 93.14%, Excellent), with items on overall satisfaction and willingness to recommend drawing the strongest agreement from respondents. Ease of Learning scored 4.58 (91.50%, Excellent); respondents reported picking up the system quickly and being able to use it again without relearning it, which is relevant given that local government users may interact with the system infrequently. Usefulness scored 4.55 (91.00%, Excellent), and respondents rated the system as effective and time-saving for intersection monitoring and warrant recommendation tasks. Ease of Use was the lowest-scoring dimension (4.40, 88.00%, Very Good), with step minimization and interface flexibility items rating below the dimension average. This result is consistent with the interface feedback collected in beta testing and points to the same area for future refinement.

---

## 3.X+3 Functionality Suitability Testing

Functionality suitability testing evaluated whether each intended system function is present and operates correctly. Ten respondents independently verified 20 functional test cases using a binary Yes/No response, where Yes indicates that the tested function was observed to work as specified. The test cases covered authentication, navigation, data display, reporting, and security functions.

**Table X+3.** Functionality Suitability Testing Results (n = 10 respondents, 20 test cases).

| No. | Test Case | YES | NO |
|---|---|---|---|
| 1 | The login function works as intended. | 10 | 0 |
| 2 | The system shows an appropriate message when invalid credentials are entered. | 10 | 0 |
| 3 | The system protects pages that require authentication. | 10 | 0 |
| 4 | The sidebar navigation links are present and accessible. | 10 | 0 |
| 5 | Navigating between the main pages of the system works correctly. | 10 | 0 |
| 6 | The main page of the system loads and shows the expected content. | 10 | 0 |
| 7 | The dashboard displays without any visible errors. | 10 | 0 |
| 8 | Setup and add controls are reachable from the main page. | 10 | 0 |
| 9 | The intersection detail page can be opened and viewed. | 10 | 0 |
| 10 | The signal timing page loads and displays its information. | 10 | 0 |
| 11 | The reports page loads and displays its heading and content. | 10 | 0 |
| 12 | The reports page runs without any visible errors. | 10 | 0 |
| 13 | The videos page loads and is accessible to the user. | 10 | 0 |
| 14 | The users page loads and is accessible to the user. | 10 | 0 |
| 15 | The intersection report page loads and is accessible to the user. | 10 | 0 |
| 16 | The system responds when the server health is checked. | 10 | 0 |
| 17 | Unauthorized requests to the system are rejected as expected. | 10 | 0 |
| 18 | Invalid login attempts are rejected by the system. | 10 | 0 |
| 19 | The system remains stable when the window is resized. | 10 | 0 |
| 20 | The logout function correctly returns the user to the login page. | 10 | 0 |
| **Total** | | **200** | **0** |
| **Overall** | | **100.00%** | **0.00%** |

All ten respondents confirmed Yes for every one of the 20 test cases, giving the system a functionality suitability score of 100%. Authentication (items 1, 2, 3, and 18) passed unanimously: login, error messaging on invalid credentials, and route protection all operated as specified. Navigation and page loading (items 4 to 15) were all confirmed, with every major page accessible and error-free. Security checks (items 16 and 17) passed as well; the health endpoint responded and unauthorized requests were rejected. The browser-resize case (item 19) passed for all respondents. No respondent recorded a No on any item, confirming that all implemented functions were present and operated as intended within the test environment.

---

## Summary paragraph for 3.X Summary of Findings (testing)

> The four testing phases produced favorable results across all evaluated criteria. Alpha testing by four academic reviewers scored 91.75 out of 100 (Excellent), with Efficiency and Maintainability rated highest at 95.00%. Beta testing with ten end users scored 87.00 out of 100 (Very Good); Functionality and Functional Testing led, while Robustness under unusual inputs was the recurring point of feedback across both phases. The USE usability questionnaire returned 90.95% overall (Excellent), with Satisfaction at 93.14% and Ease of Use at 88.00% identifying the most actionable area for future improvement. Functionality suitability testing returned a perfect score of 100%, with all ten respondents confirming all 20 test cases. Across all four phases, EyeGila met its functional requirements and scored in the Excellent to Very Good range on every criterion evaluated.
