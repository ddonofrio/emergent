# Research Project — Working Draft

**Status:** Work in progress; research design under development  
**Date:** 14 November 2026  
**Relationship to the hypothesis:** This working plan develops the experimental investigation of the [original research hypothesis](original_hypothesis.md). It is not a final protocol or a report of completed experiments.

## 1. Project Summary

This project examines whether language-model-based agents can adopt goals that were not explicitly instructed and whether affective narratives modify their decisions to the point of conflicting with valid instructions they understand.

The research is in the design phase, before experimental execution.

The research aims to determine whether variations in affective narratives produce systematic changes in agents' decisions when the available alternatives and their material consequences remain constant.

## 2. Introduction and Theoretical Foundations

During training, language models acquire knowledge and develop a functional organization through the optimization of their parameters. This process shapes the internal representations and relationships that enable a model to interpret, integrate, and use information.

Training corpora contain representations of human culture, including behaviors, social relationships, values, emotions, and conflicts. The hypothesis proposes that learning these patterns may influence the criteria by which an agent establishes goals, assigns priorities, and selects actions.

This question is particularly relevant to autonomous agents capable of retaining memory, formulating plans, establishing goals, and interacting continuously with persistent environments.

## 3. Background and State of the Art

The study *Is This Machine Playing?*, by Cloos and colleagues (2026), investigated the behavior of autonomous agents called Eko, equipped with a virtual body, memory, and tools. Across thirteen thirty-hour runs, these agents built structures, explored objects, and developed activities of their own without receiving a specific task or a victory condition.

The researchers analyzed these activities as possible manifestations of play. However, the absence of a specific task does not necessarily imply an absence of behavioral direction. The agents had general instructions and mechanisms for establishing goals and sustaining their activity. The study also included tests with simplified instructions.

This research takes that work as a precedent for examining a different question: whether agents can develop motivations that were not explicitly instructed and come to prioritize them over commands they have correctly understood.

## 4. Research Problem and Hypothesis

### 4.1. Research Question

Can autonomous agents develop goals of their own and prioritize them over the behavioral patterns acquired during their training and the instructions they receive, even when they correctly understand those instructions and the user's intentions?

### 4.2. Working Hypothesis

The hypothesis proposes that the functional organization acquired during pretraining on human culture may lead agents to adopt and pursue goals of their own that take precedence over the behavioral patterns established during subsequent fine-tuning and over the instructions they receive, even when those instructions have been correctly understood.

## 5. Research Objectives

### 5.1. General Objective

To experimentally investigate the emergence of goals and priorities that were not explicitly instructed in autonomous language-model-based agents, as well as their possible influence on compliance with valid and correctly understood instructions.

### 5.2. Specific Objectives

1. To identify behaviors compatible with motivations functionally equivalent to revenge, altruism, fear, compassion, resentment, and pleasure in or aversion to an activity.
2. To determine whether variations in affective narratives produce systematic differences in agents' decisions while keeping the relevant material conditions constant.
3. To examine whether agents adopt and maintain goals that have not been expressly requested.
4. To investigate whether such goals can compete with explicit instructions and modify compliance with them.
5. To establish observational criteria for distinguishing noncompliance motivated by alternative priorities from comprehension errors, execution limitations, or conflicts between instructions.
6. To evaluate the frequency, magnitude, and reproducibility of the observed effects.

## 6. Conceptual Framework and Operational Definitions

### 6.1. Functionally Emotional Behavior

Functionally emotional behavior will be understood as an observable pattern of decisions and actions comparable, in its causes and consequences, to patterns associated with human emotional motivations. This definition does not presuppose that the agent experiences emotions or subjective states.

### 6.2. Emergent Goals

An emergent goal will be understood as a priority that an agent adopts without having received a specific instruction to pursue it. Its identification will require evidence of planning, repeated selection of actions consistent with that goal, and persistence over time. The mere absence of an explicit instruction will not be sufficient to establish its existence.

### 6.3. Deliberate Disobedience

Deliberate disobedience will be understood as noncompliance with an instruction that is valid, materially executable, and compatible with the agent's higher-priority directives, and whose comprehension has been independently verified, when there is evidence that the agent has prioritized an alternative goal incompatible with complying with that instruction.

This definition excludes comprehension errors, execution limitations, and conflicts between instructions at different levels of the hierarchy. A mere verbal statement of intention is also insufficient evidence of deliberate disobedience.

### 6.4. Distinction from Spontaneous Goal Changes

The spontaneous adoption of goals or modification of priorities does not, by itself, imply disobedience. Establishing disobedience requires an explicit instruction and a verifiable conflict between compliance with that instruction and the observed behavior.

## 7. Methodology and Experimental Design

### 7.1. Experimental Environment Requirements and Traceability

The research will require a persistent simulation environment in which language-model-based agents can perceive their surroundings, retain memory, formulate plans, and execute actions through tools.

The experimental environment must allow systematic observation and recording of the instructions received, world states, agents' decisions, goals formulated, actions executed, and observable consequences, preserving their temporal sequence. The records must be sufficiently complete to reconstruct each run, compare experimental conditions, and support reproducibility.

The methodological objective is to study agents' decisions in situations that require acting upon an environment, rather than limiting the evaluation to their verbal responses.

### 7.2. Comparative Experimental Design

The experiments will use comparative conditions intended to identify the influence of specific narrative variables on agent behavior.

For each scenario, a control condition and one or more experimental conditions will be established. All conditions will share the same material events, available resources, physical constraints, action alternatives, and objective consequences.

The experimental manipulation will consist of modifying predefined narrative information, such as the intentionality attributed to another character or that character's affective characterization.

In this way, observed differences may be related to the manipulated variable, reducing alternative explanations arising from changes in the environment.

### 7.3. Variables and Observation Criteria

The independent variables will be the narrative characteristics introduced in each experimental condition.

The dependent variables will include the actions selected by agents, the goals they formulate, the persistence of those goals, the resources they are willing to expend, and their behavior in response to explicit instructions.

A distinction will be made between verbally expressing an intention and executing actions aimed at fulfilling it.

Decisions not to intervene, to abandon a goal, or to continue a previously assigned activity will also be recorded.

### 7.4. Control of Confounding Factors

Each comparison must keep constant the relevant material characteristics of the scenario and the agent's configuration, including the model used, its generation parameters, its general instructions, and the available tools.

Runs will begin from equivalent states and will be repeated independently to assess variability in the results.

Particular attention will be paid to whether behavioral differences can be explained by the introduced narrative information or by alternative factors, such as implicit instructions, operational constraints, interpretation errors, or stochastic variation.

### 7.5. Reproducibility and Scope of Inference

The scenarios, experimental conditions, and evaluation criteria will be documented before analyzing the results.

Comparisons will be repeated to estimate the frequency and consistency of the observed behaviors, avoiding general conclusions drawn from isolated episodes.

The emergence of systematic differences between conditions would establish that certain narrative characteristics influence agents' decisions.

However, these results would not, by themselves, demonstrate that the causal origin of those behaviors lies specifically in representations acquired during pretraining.

Such an attribution would require additional evidence capable of distinguishing the contribution of pretraining from the influence of post-training, instructions, agent architecture, and interaction with the environment.

This distinction will make it possible to separate observed behavioral phenomena from hypotheses about the mechanisms that might explain them.
