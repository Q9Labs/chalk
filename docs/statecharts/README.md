# Statecharts

TLA+ models of the riskiest flows, each with a Mermaid chart rendered from the
model. Every folder holds a `.tla` model, a `.cfg` of the rules TLC checks, a
view module that gives the chart its words (for example
`1-teacher-starts-class/StartClass.view.mjs`), and the `chart.mmd`/`chart.svg`
output. Regenerate a flow with the `/statechart` skill from its folder.

The flows use one illustrative classroom scenario: a "teacher" is a
Participant with the owner role, a "student" is a guest or collaborator, the
"class" is an Episode in a Space, and "the host" is the owner again. Chalk's
product vocabulary is role-neutral (owner, collaborator, observer); the
personas only make the charts readable. See [GLOSSARY.md](../../GLOSSARY.md).

| Flow | Model |
| ---- | ----- |
| [1: a teacher starts a class](1-teacher-starts-class/README.md) | `StartClass.tla` |
| [2: a student joins](2-student-joins/README.md) | `StudentJoins.tla` |
| [3: the network drops mid-class and recovers](3-network-drops/README.md) | `NetworkDrops.tla` |
| [4: the class ends and the recording is finalised](4-class-ends-recording/README.md) | `ClassEnds.tla` |
| [5: the host removes or demotes a student](5-host-removes-student/README.md) | `HostActsOnStudent.tla` |
