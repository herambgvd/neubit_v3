"""Every ORM table in this service, in one import.

WHY THIS FILE EXISTS. ``migrations/env.py`` builds ``target_metadata`` from
``app.db.Base.metadata``, which is populated as a SIDE EFFECT of importing model
modules. A model class Alembic has not imported by that point simply is not in the
metadata — and autogenerate does not warn about a table it cannot see, it proposes
DROPPING it. When the models lived in one flat module that risk did not exist;
now that they live in seven feature packages, THIS is the file that has to be
right, and it is the reason a feature's models are never imported into
``env.py`` individually.

So: when you add a model, add its module here. Not doing so does not break a
test — it silently arms the next ``--autogenerate`` with a table drop.

Importing the modules (not the classes) is deliberate: a module import registers
every table the module declares, including one added later that nobody remembered
to name here.

Nothing but the migration environment should import this. Application code should
import the one model it needs from the feature that owns it.
"""

from __future__ import annotations

from .correlation import models as correlation_models  # correlation_dedup
from .forms import models as forms_models  # workflow_forms
from .instances import models as instances_models  # workflow_instances
from .notifications import models as notifications_models  # notification_templates,
#                                                            notification_channels,
#                                                            notifications, device_tokens
from .sops import models as sops_models  # sops, workflow_states, workflow_transitions
from .threat_levels import models as threat_levels_models  # threat_levels
from .triggers import models as triggers_models  # workflow_triggers, alert_formats

__all__ = [
    "correlation_models",
    "forms_models",
    "instances_models",
    "notifications_models",
    "sops_models",
    "threat_levels_models",
    "triggers_models",
]
