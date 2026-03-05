SHELL := /bin/sh

.PHONY: help up down restart rebuild logs ps config clean clean-all

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Docker targets:"
	@echo "  up        Build and start services in background"
	@echo "  down      Stop and remove services (keeps named volumes)"
	@echo "  restart   Restart running services"
	@echo "  rebuild   Force rebuild + restart services"
	@echo "  logs      Follow compose logs"
	@echo "  ps        Show compose service status"
	@echo "  config    Render validated compose config"
	@echo "  clean     Down + remove dangling Docker resources (keeps named volumes)"
	@echo "  clean-all Down + remove dangling resources and named volumes"

up:
	docker compose up -d --build

down:
	docker compose down

restart:
	docker compose restart

rebuild:
	docker compose up -d --build --force-recreate

logs:
	docker compose logs -f

ps:
	docker compose ps

config:
	docker compose config

clean:
	docker compose down
	docker system prune -f

clean-all:
	docker compose down -v
	docker system prune -af --volumes
