#!/bin/sh
# Administrator-only opt-in; never executed by a recipe or a tenant request.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run as root'; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3,12), "Python >=3.12 required for Ansible 2.20"'
python3 -m venv /opt/ai-support-zabbix-ansible
/opt/ai-support-zabbix-ansible/bin/pip install --disable-pip-version-check 'ansible-core==2.20.11'
/opt/ai-support-zabbix-ansible/bin/ansible-playbook --version
# Shared controller collections remain at /usr/share/ansible/collections.
# Operator enables AI_SUPPORT_AGENT_ZABBIX_CONTROLLER=2.20 after validation.
