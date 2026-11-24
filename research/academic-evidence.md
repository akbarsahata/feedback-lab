# Academic evidence: sensitive disclosure to public generative AI tools

Research date: 11 October 2026. Focused primary-source scan, not a systematic or exhaustive literature review. Publication venues and sample sizes below were checked against author manuscripts, proceedings, or institutional records. This report does not assess the user's three publications.

## Assessment and terminology

The proposed problem is academically legitimate: several peer-reviewed studies directly examine sensitive information in real chatbot conversations, users' disclosure decisions, misconceptions, and mitigation interfaces [1–7]. That validates the phenomenon, but does not establish that a particular proposed solution is original or effective.

Define the problem as **unnecessary or unintended disclosure of personal, third-party, or organizational sensitive information to an external generative AI service**. A public-access service is not equivalent to a publicly readable conversation. Separate sending data to a provider, onward processing/sharing, model-training reuse, inference of attributes, and actual unauthorized extraction. Their conditions differ. Not every sensitive disclosure is inappropriate: necessary, informed, authorized disclosure can be legitimate.

## Primary evidence register

### 1. Zhang et al. — “It's a Fair Game”, or Is It? (CHI, May 2024)

[Author full paper](https://sauvikdas.com/papers/53/serve); [DOI](https://doi.org/10.1145/3613904.3642385).

**Design:** qualitative coding of 200 ShareGPT conversations containing 10,380 messages, followed by 19 semi-structured interviews. The conversation sample deliberately oversampled PII-rich threads. **Findings:** disclosure involved users and other people; conversational requests encouraged additional detail. Interviews identified utility/convenience trade-offs, inaccurate mental models, weak knowledge of controls, and ad hoc privacy practices. **Limits:** neither representative prevalence nor causal proof; early product controls described in this paper must not be assumed current. This is a strong anchor for the human-centered problem, with contextual integrity as an analytical frame.

### 2. Mireshghallah et al. — Trust No Bot (COLM 2024; manuscript July 2024)

[Full manuscript](https://arxiv.org/html/2407.11438v2); [conference record](https://openreview.net/forum?id=tIpWtMYkzU).

**Design:** computational analysis of WildChat conversations, including task/sensitivity annotation of a 5,000-conversation sample, with human validation subsets. **Findings:** identifiable content appears during ordinary tasks such as translation and code editing; sensitive information exceeds conventional PII categories. **Limits:** volunteered public-dataset conversations are not representative of all ChatGPT use. Automated labels can contain errors; names may be fictional, public, or unrelated to the user. Reported detection rates must not become claims about the proportion of all users leaking genuine private data. Best used to motivate task-aware evaluation and broad sensitivity categories.

### 3. Kwesi et al. — Exploring User Security and Privacy Attitudes and Concerns Toward the Use of General-Purpose LLM Chatbots for Mental Health (USENIX Security, August 2025)

[Proceedings page](https://www.usenix.org/conference/usenixsecurity25/presentation/kwesi); [full paper](https://www.usenix.org/system/files/usenixsecurity25-kwesi.pdf).

**Design:** 21 semi-structured interviews with US participants. **Findings:** participants sometimes confused empathetic interaction with human accountability and believed chatbot disclosures had protections comparable to a licensed therapist. The authors characterize emotional disclosure as “intangible vulnerability,” undervalued against financial/location data. **Limits:** qualitative, self-reported, domain-specific evidence; not a causal estimate or population prevalence. Useful for explaining why a user can consider an interaction safe while revealing highly sensitive information. These are reported misconceptions, not legal advice on applicable protections.

### 4. Zhou et al. — Rescriber: Smaller-LLM-Powered User-Led Data Minimization for LLM-Based Chatbots (CHI, April 2025)

[Full manuscript](https://arxiv.org/html/2410.11876v3); [DOI](https://doi.org/10.1145/3706598.3713701).

**Design:** browser extension detecting personal information and offering user-controlled replacement/abstraction; 12-participant evaluation comparing GPT-4o and Llama3-8B implementations, plus on-device feasibility work. **Findings:** participants valued minimization, actionable alternatives, and control; convenience and meaning preservation shaped acceptance. **Limits:** small, short-term evaluation; some participants avoided their most sensitive real examples. Similar subjective scores do not establish equivalence of privacy protection. No formal privacy guarantee. **Novelty implication:** local prompt detection and redaction with user review already exist in peer-reviewed research.

### 5. Ngong et al. — Protecting Users From Themselves: Safeguarding Contextual Privacy in Interactions with Conversational Agents (Findings of ACL, July 2025)

[Proceedings](https://aclanthology.org/2025.findings-acl.1343/); [full manuscript](https://arxiv.org/html/2502.18509v2).

**Design:** six-person institutional formative study; locally deployable context/intent detection and prompt reformulation; human evaluation with 24 participants reviewing selected ShareGPT prompts. **Findings:** indirect disclosure challenged even privacy-conscious participants; approximately 76% preferred reformulations. **Limits:** selected prompts, small groups, subjectivity, and LLM-based evaluation constrain generalization. Human preference is not verified downstream safety. The authors identify exact-content translation/summarization as difficult and provide no formal guarantee. **Novelty implication:** task relevance plus privacy-preserving prompt rewriting is also established prior art.

### 6. Cheng et al. — The Privacy Paradox of LLMs: User Perceptions and the Reality of PII Leakage (CHI, April 2026)

[Institutional publication record and abstract](https://digitalcommons.odu.edu/computerscience_fac_pubs/447/); [DOI](https://doi.org/10.1145/3772318.3791809).

**Design:** technical PII extraction study plus 20 interviews and survey of 204 participants, as verified in the institutional abstract. **Findings:** continued use despite concern, limited training-data understanding, perceived utility, and privacy cynicism. **Limits:** this report verified abstract-level findings, not all methods or attack details. The extraction experiment and users' reported concern do not demonstrate that these participants' own prompts were extracted. Useful recent corroboration; obtain/read full methods before relying on effect sizes or generalizing survey results.

### 7. Liu et al. — Designing Privacy Choice in Generative AI Chatbot Ecosystems (CHI, April 2026)

[Authors' institutional abstract](https://research.google/pubs/designing-privacy-choice-in-generative-ai-chatbot-ecosystems/); [DOI](https://doi.org/10.1145/3772318.3790809).

**Design:** two vignette survey studies totaling 486 participants and 16 follow-up interviews; explores privacy choice timing and first-/third-party ecosystems. **Findings:** perceived trust and control differ across personalization and onward-sharing contexts. **Limits:** US participants and simplified flight-booking storyboards; preference/satisfaction is not actual protection or long-term informed choice. Authors call for realistic, multi-turn interaction studies. This provides a concrete basis for testing intervention timing and information-flow explanations rather than merely adding another generic warning.

### 8. Staab et al. — Beyond Memorization: Violating Privacy via Inference with Large Language Models (ICLR 2024; preprint October 2023)

[Paper](https://arxiv.org/abs/2310.07298); [conference manuscript](https://openreview.net/pdf?id=kmn0BhQk7p).

**Design:** model experiments inferring personal attributes from real Reddit profiles, plus investigation of privacy-invasive chatbot questioning. **Findings:** attributes can be inferred from text even without direct identifier extraction; common anonymization/alignment defenses were insufficient in their setup. **Limits:** performance depends on dataset, attributes, available clues, and model. Does not establish all anonymized text is identifiable or that current services infer every user's attributes. Supports a separate inferential-threat model: name/email removal alone is not a complete privacy definition.

### 9. Carlini et al. — Extracting Training Data from Large Language Models (USENIX Security, August 2021)

[Proceedings and paper](https://www.usenix.org/conference/usenixsecurity21/presentation/carlini-extracting).

**Design:** adversarial extraction from GPT-2 trained on public-web data. **Findings:** hundreds of verbatim training sequences were recovered, including public names/contact details and other text, sometimes from a single training document. **Limits:** training-data memorization experiment, not a study of modern chatbot uploads. Demonstrates a feasible mechanism rather than the probability that a particular submitted document will be exposed. Any claim about uploaded-prompt extraction additionally requires evidence of retention, training inclusion, memorization, and accessible extraction conditions.

### 10. Nasr et al. — Scalable Extraction of Training Data from Aligned, Production Language Models (ICLR 2025; earlier related preprint November 2023)

[Final author-hosted paper](https://afedercooper.info/paper/nasr2025extracting.pdf); [conference record](https://openreview.net/forum?id=vjel3nWP2a); [earlier project](https://not-just-memorization.github.io/).

**Design:** attacks on aligned production models that induce training-data extraction. **Findings:** attacks recovered thousands of training examples, demonstrating limits of alignment as a privacy safeguard. **Limits:** historical tested systems/attack settings; this does not establish current exploitability, represent every provider, or demonstrate extraction of a newly uploaded private prompt. Cite final title/version carefully because the earlier preprint has a different title and author list. Supports technical plausibility of a downstream risk, not an inevitable consequence of upload.

### 11. Nissenbaum — Privacy as Contextual Integrity (Washington Law Review, February 2004)

[Original publication](https://digitalcommons.law.uw.edu/wlr/vol79/iss1/10/).

**Contribution:** theoretical account of privacy as appropriate information flows within contexts, not merely secrecy. **Limit:** foundational normative work, not empirical evidence of chatbot behavior. For this thesis it motivates asking who sends whose information, to which recipient, for which purpose, under which conditions. A classifier's sensitivity label alone cannot settle whether an information flow is appropriate.

## Causal model to investigate, not assume proven

The candidate pathway is: an AI-assisted task creates demand for context → users underestimate sensitivity or misunderstand recipients/processing, or knowingly accept a utility trade-off → a prompt/document includes unnecessary information → external processing creates exposure → additional conditions may produce misuse or unauthorized access.

The evidence establishes disclosure examples, reported motivations, and technical attack mechanisms at different points. It does not establish this entire pathway causally in one representative longitudinal study. Avoid “users ignore privacy because they are careless.” Distinguish inadvertent disclosure, uninformed disclosure, informed acceptance, and constrained choice. Interviews and surveys can investigate these differences; controlled studies can test specific interventions.

## Consequences: claims that need different evidence

| Consequence | Evidence status in this source set | Appropriate thesis framing |
|---|---|---|
| Sensitive data reaches a provider or public research dataset | Observed in conversation studies [1–2] | Measurable disclosure/exposure outcome |
| Other people's information is disclosed | Observed qualitative examples [1] | Interdependent privacy and authority/consent concern |
| Identifiers removed but attributes remain inferable | Experimental mechanism [8] | Residual inferential exposure, conditional on attacker knowledge |
| Training data can be extracted | Demonstrated in tested models [9–10] | Conditional downstream threat, separate from direct prompt exposure |
| Fraud, discrimination, extortion, disciplinary action, reputational or commercial loss | Not measured as incidence in these user studies | Plausible harm categories requiring separate incident/longitudinal evidence |

## Grounded master's directions — proposals, novelty unverified

1. **Indonesian task-aware minimization.** Compare a lightweight local detector with rules/NER and a local small LLM on Indonesian or mixed Indonesian-English prompts/documents. Label both sensitivity and task necessity. Measure span recall, missed high-severity items, false alarms, downstream task quality, latency, and memory. Language adaptation alone is weak unless real linguistic/task challenges produce a useful evaluated contribution.
2. **Meaning-preserving document tasks.** Test whether pseudonyms, typed placeholders, or selective abstractions protect information during translation, summarization, or drafting while preserving facts and relationships. This directly addresses a limitation identified in [5], but requires further literature checking and comparison with existing systems such as [4].
3. **Behavior and interface evaluation.** Compare static warning, contextual explanation, and explanation plus editable minimization suggestions in realistic multi-turn tasks. Measure actual simulated disclosure and task success, not intention alone; include warning fatigue, calibration, and misleading reassurance. Motivation comes from short/vignette evaluations in [4–7], not proof no similar experiment exists.

Use synthetic or carefully consented material in studies; do not elicit genuine secrets to prove risk. The intervention must act before external transmission. If the privacy detector itself sends raw content to another cloud model, include that recipient in the threat model. A local design can reduce this additional exposure but still needs checks of logging, telemetry, and storage.

## Thesis positioning

The strongest initial problem statement is: **Users of external generative AI assistants can disclose sensitive information beyond what a task requires, while existing minimization methods face limits in context judgment, task fidelity, practical deployment, and user decision support.** The broad problem is validated; the chosen population, task, and intervention remain research decisions. A classification accuracy improvement on synthetic structured records would not by itself establish effective protection of unstructured, contextual prompts or documents.

The business translation is prevention of avoidable data exposure with tolerable workflow cost. That practical objective should follow the academic operationalization: define recipient and policy boundaries, quantify protection/utility trade-offs, and establish where the mechanism fails. This source set cannot supply a defensible market size, incident rate, or monetary ROI.
