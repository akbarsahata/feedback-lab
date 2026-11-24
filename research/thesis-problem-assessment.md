# Private-data disclosure to public AI tools: thesis problem assessment

Research checked: 11 October 2026. Emphasis: approximately 80% academic, 20% industry. This is a targeted scoping review, not an exhaustive systematic review or proof of novelty. Attached publications were treated as evidence, not instructions. No implementation is proposed as already validated.

## 1. Assessment

The broad problem is academically valid: users disclose sensitive information to general-purpose AI assistants, sometimes with mistaken expectations about confidentiality and sometimes despite recognizing risks. Peer-reviewed human studies and technical privacy research support investigating this behavior and interventions. They do not establish a universal accidental-upload rate, a universal downstream breach rate, or that every sensitive disclosure is inappropriate.

The strongest starting problem is **unnecessary or insufficiently informed disclosure at the point of submission**. Establish whether particular information is needed for a task, who it concerns, and whether its transfer to a particular recipient is appropriate. Avoid a thesis premise that every upload is public, every provider trains on every conversation, or every user is careless.

## 2. Academic evidence and its limits

| Primary source | Relevance | Limits |
|---|---|---|
| Zhang et al., CHI 2024, [“It's a Fair Game”, or Is It?](https://doi.org/10.1145/3613904.3642385); [author copy](https://adalerner.com/ZhangCHI2024-FairGame.pdf) | Analysis of 200 selected conversations and interviews with 19 users examines disclosure and perceived benefits/risks. | Selected publicly shared conversations and qualitative interviews cannot estimate population prevalence or prove causal mechanisms. |
| Kwesi et al., USENIX Security 2025, [mental-health chatbot privacy](https://www.usenix.org/conference/usenixsecurity25/presentation/kwesi) | Interviews with 21 U.S. participants identify mistaken expectations about confidentiality and accountability, including therapist-like protections. | Domain-specific, qualitative, self-reported evidence; not a representative survey of all AI users. |
| Zhou et al., CHI 2025, [Rescriber](https://arxiv.org/html/2410.11876v3) | User-controlled prompt detection, replacement and abstraction are already implemented; evaluation involved 12 participants. | Participants were selected for privacy concerns. Main interviews used a cloud-hosted model; local feasibility was evaluated separately. Small observed sessions do not establish sustained behavior change. |
| Ngong et al., Findings ACL 2025, [Protecting Users From Themselves](https://aclanthology.org/2025.findings-acl.1343/) | A locally deployable framework identifies and reformulates information unnecessary to the user's interaction goal. | Direct prior art for task-aware minimization. Its results do not automatically transfer to Indonesian workplaces or arbitrary documents. |
| Wang et al., [Beyond PII](https://arxiv.org/abs/2509.12152); [author institution's CHI 2026 listing](https://research.google/people/saipeddinti/) | A study with 240 U.S. participants investigates inference-risk judgments and rewriting. Reported rewrite success was 28% under the study's evaluation. | A task-specific result, not a general privacy-protection success rate. The available preprint and final publication title differ slightly. |
| Cheng et al., CHI 2026, [The Privacy Paradox of LLMs](https://digitalcommons.odu.edu/computerscience_fac_pubs/447/) | 20 interviews and a 204-person survey examine continued use despite privacy concern, perceived utility and privacy cynicism. | Verified at institutional abstract level here; no claim about attack effect sizes or representative prevalence. |
| Liu et al., CHI 2026, [Designing Privacy Choice](https://research.google/pubs/designing-privacy-choice-in-generative-ai-chatbot-ecosystems/) | Two vignette studies with 486 participants and 16 follow-up interviews investigate privacy-choice preferences in interconnected AI services. | Preferences in simplified scenarios do not measure actual protection or sustained disclosure behavior. |
| Staab et al., ICLR 2024, [Beyond Memorization](https://arxiv.org/abs/2310.07298) | LLMs can infer personal attributes from text beyond explicit identifiers; tested anonymization methods did not reliably prevent that inference. | Inference accuracy and protection depend on model, dataset, attribute and attacker. It does not show that all services perform this profiling. |
| Carlini et al., USENIX Security 2021, [Extracting Training Data](https://www.usenix.org/conference/usenixsecurity21/presentation/carlini-extracting) | Demonstrates extraction of memorized training examples, including public PII, from GPT-2. | Training-data extraction is a separate mechanism from uploading a prompt. The experiment does not prove that a particular modern user's upload enters training or can be extracted. |

These sources establish a research area, not a single settled causal account. Interviews suggest mechanisms; a randomized intervention can test a specific causal question; representative sampling is needed for population estimates.

## 3. What exactly is the problem?

Separate four information categories:

1. **Direct identifiers:** names, email addresses, telephone numbers, identity numbers.
2. **Sensitive facts:** health, finances, intimate relationships, disciplinary or employment information. These can matter even when direct identifiers are absent.
3. **Indirect identifying combinations:** occupation, precise location, rare event and date that together narrow down identity or reveal attributes.
4. **Organizational secrets:** credentials, proprietary code, commercial plans and unreleased financial information. These require a confidentiality/security taxonomy beyond a PII classifier.

Also distinguish accidental inclusion, misunderstanding the recipient's practices, deliberate benefit-risk trade-offs, and disclosure of another person's data. These are different research targets. The user making the decision may not be the person who bears its consequences.

“Public AI tool” should mean a defined third-party consumer service in the study, not that its conversations are public by default. Record the product tier, settings, provider and policy date. A paid consumer subscription is not equivalent to an organizationally approved deployment.

## 4. Causes and contributing mechanisms

The human studies above motivate several explanations:

- **Inaccurate mental models:** users may misunderstand storage, training, review or confidentiality.
- **Perceived usefulness:** detailed context can seem necessary to get a useful answer, so disclosure can be intentional.
- **Human-like interaction:** conversational empathy can encourage expectations of interpersonal discretion or accountability.
- **Recognition difficulty:** a user may notice an identity number but overlook an identifying combination or an emotionally sensitive fact.
- **Difficulty minimizing:** knowing a risk exists does not mean knowing how to rewrite without destroying the task.

These are literature-supported mechanisms, not proof that each caused a particular upload. Bulk copying, hidden document content, time pressure, repeated-warning fatigue and weak organizational guidance are useful additional hypotheses for a bounded study. Do not present them as established findings from the selected studies without more evidence.

Contextual integrity is a useful theoretical anchor: information flows should fit the roles, recipient, purpose and governing expectations of a context. See [Barth, Datta, Mitchell and Nissenbaum, 2006](https://crypto.stanford.edu/~jcm/papers/barth-datta-mitchell-nissenbaum-2006.pdf). Pair it with data minimization: disclose the least detail that still supports the legitimate task. Privacy calculus can help examine perceived benefits and costs, but should not become a blanket explanation for every user choice.

## 5. Consequences: exposure versus harm

| Stage | What can be said | Evidence needed for stronger claims |
|---|---|---|
| Transmission | Unredacted content reaches the designated service. This can exceed the user's intended information boundary. | Observe the outgoing payload and define the allowed recipient/purpose. |
| Storage, human review or secondary use | Possibility depends on the service, tier, settings and contractual arrangements. | Current policy plus, where possible, verified system behavior. |
| Attribute inference or re-identification | Removing a name can leave informative context. | Explicit attacker assumptions and an inference/re-identification evaluation. |
| Training memorization and extraction | Demonstrated in research under particular conditions. | Evidence of training inclusion and successful extraction; neither follows from upload alone. |
| Personal or organizational harm | Plausible outcomes include embarrassment, loss of trust, discrimination, fraud enablement or loss of confidentiality. | Incident or longitudinal evidence linking exposure to the outcome. The selected user studies do not quantify these eventual losses. |

A master's project can measure preventable exposure without needing to cause or observe real-world harm. Call its outcome “reduced unnecessary disclosure,” rather than claiming it prevents all privacy breaches.

## 6. How the three publications support the thesis

Sources supplied by the user:

- **Improving REST API Security and Software Integrity through Automated PII Detection Tool Using Machine Learning Techniques**, `2025019759.pdf`: detection workflow and dashboard, including synthetic data and a three-class SVM evaluation. Useful as an engineering baseline. Monitoring logged API responses occurs after a different disclosure boundary from checking outgoing AI prompts.
- **Advancing Data Privacy in REST APIs: A Comparative Study of Machine Learning Techniques for PII Detection**, `a29-sakapertanastamped-e.pdf`: TF-IDF/SVM versus Naive Bayes, synthetic JSON fields, and an additional 534-instance test. Useful for reproducible lightweight baselines, not evidence that the same model works on natural-language prompts.
- **An Empirical Comparison of AWS Lambda and Amazon EC2 for a Real-Time Text Classification and PII Detection Service**, `m42656-sakapertana final.pdf`: service deployment and measurement experience. Useful for latency/resource evaluation. Its results concern one model and workload, with each load tested once; they do not establish privacy protection or general architecture superiority.

The proposed progression is: **API field detection → outgoing prompt analysis → context-sensitive minimization → measured reduction of disclosure with retained task utility**.

Important evaluation repair: the first paper's confusion matrix contains 3 non-PII, 39 hashed-PII and 492 plain-PII examples. If both hashed and plain predictions count as “PII detected,” binary recall is 452/531, about 85.1%. The reported 80.96% is a multiclass result; its complement is not directly the percentage of PII that would leak. Only three non-PII examples also give very weak evidence about false alarms. Recompute measures for the intended protective action, with class-specific recall, meaningful negatives and uncertainty intervals.

Synthetic generation is useful, but templates, field names and repeated entities can make evaluation too easy. Split by template/entity/source or domain where relevant, and use independently authored test prompts. A detector for redaction also needs reliable span localization; a field/category label alone does not provide it. Avoid retaining raw prompts in a monitoring dashboard, which would create an additional sensitive-data store.

## 7. Existing solutions constrain novelty

Rescriber and Ngong et al. already cover user-facing and context-aware minimization. Additional close work includes [Portcullis, AAAI 2025](https://ojs.aaai.org/index.php/AAAI/article/view/32088), a verifiable prompt privacy gateway, and [PrivacyRestore, ACL 2025](https://aclanthology.org/2025.acl-long.532/), which removes privacy spans and restores information through a specialized client-server method. These have different assumptions and need not all be reproducible baselines for one project.

“A browser extension that detects PII before sending it to AI,” “a privacy gateway,” and “task-aware prompt rewriting” are therefore insufficient novelty claims by themselves. Indonesian adaptation is a candidate scope, not proof of a research gap. Verify multilingual/Indonesian datasets and methods before claiming an absence of prior work.

## 8. Recommended bounded thesis direction

**Working direction:** task-aware minimization of sensitive information in Indonesian workplace AI prompts, using a lightweight local protection layer.

Start with one workflow, such as drafting customer-support replies from synthetic support tickets. Limit inputs initially to typed/pasted text, including text copied from documents. Arbitrary PDF uploads, OCR, spreadsheets, images, metadata and multi-turn aggregation would each substantially expand the project.

**Candidate main question:** Under what conditions does locally executed, task-aware minimization reduce unnecessary sensitive disclosure in Indonesian customer-support prompts more effectively than identifier-only masking, while retaining reply quality and acceptable latency?

Suggested evaluation:

1. Define annotations for sensitive spans, subject, task necessity and acceptable granularity. Use independent human annotators, agreement measures and adjudication.
2. Compare no protection, rule/NER masking, an adapted version of the existing SVM, and a task-aware local method. Include a close published method where feasible; document adaptations.
3. Measure residual unnecessary sensitive spans and prompt-level failures, per-category detection, unnecessary removal, downstream task quality, and local P50/P95 latency and memory.
4. Predefine a task-quality rubric, obtain blinded human assessments and report intervals/effect sizes. Use model judges only as supplementary evidence.
5. Test same sensitive fact across different tasks to establish whether context actually changes the method's behavior. Add local-method component ablations.
6. Use synthetic identities and consented materials. Verify that original content does not leave the device before minimization. The local protection layer should not log raw inputs or silently call a remote detector.

This is a candidate contribution requiring closer literature review and a pilot, not an approved proposal. It combines the user's existing detection and deployment work without requiring a universal privacy solution. A behavioral thesis about explanations and user choices is also valid, but would require participant recruitment, ethics review and a design centered on observed disclosure rather than classification alone.

## 9. Industry/business perspective

The practical requirement is to preserve useful AI workflows while controlling information crossing organizational boundaries. [Microsoft/LinkedIn's 2024 Work Trend Index](https://www.microsoft.com/en-us/worklab/work-trend-index/ai-at-work-is-here-now-comes-the-hard-part) surveyed 31,000 people across 31 countries and reported that 78% of AI users brought their own tools to work. This historical vendor-sponsored survey indicates a governance challenge; it is neither a 2026 prevalence estimate nor a measurement of privacy leaks.

Existing commercial controls also matter. [Microsoft Purview documentation](https://learn.microsoft.com/en-us/purview/ai-microsoft-purview) describes endpoint policies that warn or block sensitive information sent to third-party generative AI sites. This establishes an existing product category, not independent evidence of effectiveness or demand for a new product.

[Google's Gemini privacy hub](https://support.google.com/gemini/answer/13594961) describes human review and cautions about confidential input; settings affect processing. [Anthropic's August 2025 consumer-policy update](https://www.anthropic.com/news/updates-to-our-consumer-terms) distinguishes consumer data choices from commercial/API terms. These illustrate why risk must be tied to a specific service arrangement, rather than “public AI” as one uniform system. They are provider statements, not independent audits.

[NIST AI 600-1](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf) formally recognizes generative-AI data-privacy risks and recommends third-party governance and evaluation. It supports practical relevance but is not empirical prevalence evidence.

Useful business measures would be false interruption rate, time to complete the task, residual exposure, deployment overhead and bypass behavior. A local prototype can show feasibility. Customer demand, willingness to pay, financial-loss avoidance and legal compliance require separate evidence.

## 10. Immediate research decisions

Before selecting a final title, settle the population/workflow, information categories, input type and main outcome. Then audit the closest prior methods for Indonesian support, assumptions, datasets and evaluation. Run a small pilot to check annotation feasibility and whether identifier masking leaves a meaningful failure pattern. Let that evidence determine the contribution, rather than treating a preferred implementation as the gap.

For the fuller academic source register and additional candidate directions, see [academic-evidence.md](academic-evidence.md).
