#!/bin/bash
# Allow containers (docker0 bridge) to reach host services
iptables -I INPUT -i docker0 -p tcp --dport 4001 -j ACCEPT  # Agentify API (tools)
iptables -I INPUT -i docker0 -p tcp --dport 8201 -j ACCEPT  # MCP callback
iptables -I INPUT -i docker0 -p tcp --dport 8100 -j ACCEPT  # MemPalace
iptables -I INPUT -i docker0 -p tcp --dport 9090 -j ACCEPT  # Container Manager
mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4
echo "iptables rules applied"
