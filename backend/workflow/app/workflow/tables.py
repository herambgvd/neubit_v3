"""Every ORM table in this service, in one import.

``migrations/env.py`` builds ``target_metadata`` from ``app.db.Base.metadata``,
which is populated as a side effect of importing model modules. A model Alembic
has not imported is not in the metadata, and autogenerate proposes DROPPING the
table rather than warning.

So add a new model's module here. Forgetting breaks no test — it silently arms the
next ``--autogenerate`` with a table drop.

Import the module, not the classes: that registers every table the module declares,
including ones added later.

Only the migration environment should import this. Application code imports the one
model it needs from the feature that owns it.
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
