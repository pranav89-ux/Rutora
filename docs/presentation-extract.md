# AI Urban Digital Twin — Presentation Data Extract

Source: `AI_Urban_Digital_Twin (1).pptx` (14 slides). Text below is transcribed from the slide text objects; wording and sequence are preserved. The source deck has one embedded image, preserved at `public/source-assets/presentation-image-1.png`.

## Slide 1 — Title

- MANIPAL UNIVERSITY JAIPUR
- School of Computer Science and Engineering
- Department of Computer Science and Engineering
- AI-Powered Urban Digital Twin
- AI-Based Prediction, Simulation and Decision Support for Urban Environments
- Submitted By: Pranav Srivastava, 2427030048; Parnika Joshi, 2427030021
- Supervised By: Dr. Mohit Kushwaha

## Slide 2 — Introduction

- Modern urban environments generate large amounts of continuously changing data.
- Data originates from traffic systems, weather services, GIS, infrastructure monitoring, transportation and emergency services.
- These data sources are often fragmented across independent systems.
- This makes it difficult to obtain a unified view of the current urban environment.
- Urban systems are interconnected — a change in one component can affect others.
- Source groups shown: Traffic; Weather; GIS; Infrastructure; Emergency; Unified Urban View.
- A unified, dynamic representation is required to understand, predict and simulate urban conditions.

## Slide 3 — Problem Statement

- Fragmented Data — Urban data is distributed across multiple independent systems.
- Limited Unified Visibility — Difficult to understand the overall state of interconnected components.
- Reactive Management — Many existing approaches focus on responding after an event occurs.
- Limited Prediction — Future traffic, risks and cascading effects are difficult to anticipate.
- No Safe “What-If” Testing — Alternative decisions are evaluated after implementation, not before.
- Interdependent Systems — Traffic, weather, infrastructure and emergency response influence one another.
- Limited Decision Support.

## Slide 4 — How Existing Urban Management Works

- Process: Data Sources → Individual Monitoring → Manual / Separate Analysis → Event Occurs → Response → Limited Post-Event Analysis.
- Different systems monitor individual parameters independently.
- Information may remain separated between systems.
- Operators often respond to incidents only after they occur.
- Alternative decisions are usually not simulated beforehand.

## Slide 5 — Limitations of the Existing Process

- Fragmented information across systems.
- Reactive response to events.
- Limited predictive capability.
- Difficult cross-system analysis.
- Limited scenario testing.
- Difficulty understanding cascading effects.
- Current Process: Monitor → Detect → Respond.
- Required Process: Monitor → Understand → Predict → Simulate → Compare → Decide.
- The proposed system is designed to move beyond monitor-detect-respond toward predictive, simulation-based decision support.

## Slide 6 — Proposed Solution — AI-Powered Urban Digital Twin

- Inputs: Traffic; Weather; GIS / Spatial; Roads & Buildings; Infrastructure; Emergency Resources; Incidents.
- Digital Twin.
- AI provides: Prediction; Anomaly Detection; Risk Estimation; Scenario Analysis.
- A dynamic digital representation of a selected urban/campus environment that integrates heterogeneous data and uses AI to monitor, predict and simulate urban conditions.

## Slide 7 — Proposed Workflow

1. Data Sources — Traffic, weather, GIS, infrastructure, emergency and incident data.
2. Data Integration — Heterogeneous data unified into a common structure.
3. Digital Twin — Dynamic representation of the selected urban environment.
4. AI / ML Analysis — Models process the current state of the environment.
5. Prediction & Anomaly Detection — Future conditions estimated; unusual patterns flagged.
6. What-If / Counterfactual Simulation — Alternative scenarios tested safely before action.
7. Scenario Comparison — Outcomes compared using measurable indicators.
8. Decision Support — Evidence-based recommendations are presented.
9. Human Operator — Final decision remains with the human operator.
- The system supports human decisions — it does not automatically make or enforce urban decisions.

## Slide 8 — Objectives

1. Integrate heterogeneous urban data into a unified platform.
2. Create a dynamic digital representation of a selected urban/campus environment.
3. Monitor the current state of urban components.
4. Predict future urban conditions using AI/ML.
5. Detect anomalies and estimate risks.
6. Simulate what-if and counterfactual scenarios.
7. Compare alternative scenarios using measurable outcomes.
8. Provide evidence-based decision support to human operators.

## Slide 9 — Proposed Solution Features

- Digital Twin — Interactive representation of roads, buildings and urban assets.
- Real-Time Monitoring — Current traffic, weather, incidents and infrastructure conditions.
- AI Prediction — Predicts future traffic and urban conditions.
- Anomaly Detection — Identifies unusual patterns and abnormal conditions.
- Scenario Simulation — Tests road closures, weather changes, infrastructure failures and demand changes.
- Scenario Comparison — Compares congestion, travel time, traffic flow and response time.

## Slide 10 — Example Scenario: What-If Simulation

- Question: What happens if a major road is closed during heavy rainfall?
- Current State: Road Open; High Traffic; Heavy Rain.
- Scenario: Road Closed; High Traffic; Heavy Rain.
- Simulation compares outcomes for Average Travel Time, Congestion, Traffic Flow, and Emergency Response Time.
- The system provides scenario outcomes for the human operator to evaluate.

## Slide 11 — Expected Outcomes

- As a PBL prototype, these are expected system outcomes — not experimentally validated results.
- Unified visualization of urban data.
- Improved visibility of urban conditions.
- Traffic and urban-state predictions.
- Early identification of anomalies.
- Risk estimation.
- What-if scenario simulation.
- Counterfactual analysis.
- Quantitative scenario comparison.
- Better evidence for planning and response.
- Traditional Approach: Fragmented → Reactive → Limited Scenario Testing.
- Proposed Approach: Integrated → Predictive → Simulative → Decision Support.

## Slide 12 — Technology Stack

- Frontend: React.js; TypeScript; Tailwind CSS; MapLibre / Leaflet.
- Backend: Python; FastAPI; REST APIs; WebSockets.
- Database: PostgreSQL; PostGIS; Redis.
- AI / ML: Python; Pandas / NumPy; Scikit-learn; PyTorch.
- Simulation: SUMO; TraCI.
- Development: Git; GitHub; Docker.

## Slide 13 — Project Roadmap

- Semester 1 — Core Digital Twin: Selected campus/urban environment; Interactive map; Data integration; Traffic and weather monitoring; Basic AI prediction; Anomaly detection; Basic scenario simulation; Dashboard.
- Semester 2 — Advanced Intelligence: 3D Digital Twin; Advanced traffic simulation; Counterfactual analysis; Uncertainty handling; Multi-agent AI; Natural-language scenario interaction; Optimization; Advanced decision support.

## Slide 14 — Conclusion

- The proposed AI-powered Urban Digital Twin moves urban management from simple monitoring toward prediction, simulation and evidence-based planning.
- Observe → Predict → Simulate → Compare → Decide.
- “A Digital Twin for understanding not only what is happening, but what could happen next.”

## Extract scope

The text is extracted from slide XML text elements. The single embedded image is retained separately. No speaker notes were present in the source deck.
