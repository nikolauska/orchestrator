# Projects tool

The Projects tool maintains the set of local projects available for coordinated work.

## Registering projects

A project is an existing local source repository registered under a stable name. The stable name is what later work requests use to select the project.

The tool can:

- list registered projects;
- add an existing repository;
- remove a registration without deleting the project;
- set a default location for newly created projects; and
- create and register a new empty project.

A project can be registered only once under one name. Registration requires the repository's top-level directory, which prevents accidentally targeting a nested folder.

## Creating projects

Creating a project requires either:

- a previously configured default projects location; or
- an explicit destination.

The destination must not already exist. If setup fails after the folder is created, the folder remains available for inspection rather than being removed automatically.
