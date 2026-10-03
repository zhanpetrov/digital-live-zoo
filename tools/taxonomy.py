"""Animal labels for cams, and the hubs built from them.

guess_animals(cam) suggests animal keys from a cam's name. It runs only when a cam is first seen;
after that the labels live in data/cams.json and can be corrected by hand.
"""
import re

# key -> display name (plural, as people search for it). A hub page is built for a key once it has 3+ live cams.
ANIMALS = {
    "penguins": "Penguins",
    "bald-eagles": "Bald eagles",
    "ospreys": "Ospreys",
    "peregrine-falcons": "Peregrine falcons",
    "storks": "Storks",
    "owls": "Owls",
    "hummingbirds": "Hummingbirds",
    "puffins": "Puffins",
    "backyard-birds": "Backyard birds",
    "kestrels": "Kestrels",
    "brown-bears": "Brown bears",
    "polar-bears": "Polar bears",
    "elephants": "Elephants",
    "giraffes": "Giraffes",
    "rhinos": "Rhinos",
    "zebras": "Zebras",
    "wildebeest-migration": "Wildebeest migration",
    "tigers": "Tigers",
    "lions": "Lions",
    "great-apes": "Great apes",
    "giant-pandas": "Giant pandas",
    "red-pandas": "Red pandas",
    "sloths": "Sloths",
    "wolves": "Wolves",
    "deer": "Deer",
    "elk": "Elk",
    "bats": "Bats",
    "raccoons": "Raccoons",
    "hedgehogs": "Hedgehogs",
    "badgers": "Badgers",
    "foxes": "Foxes",
    "squirrels": "Squirrels",
    "otters": "Otters",
    "seals": "Seals and sea lions",
    "orcas": "Orcas",
    "manatees": "Manatees",
    "sharks": "Sharks",
    "jellyfish": "Jellyfish",
    "coral-reefs": "Coral reefs",
    "kelp-forests": "Kelp forests",
    "salmon": "Salmon",
    "alligators": "Alligators",
    "tortoises": "Giant tortoises",
    "cats": "Cats and kittens",
    "dogs": "Puppies and dogs",
    "goats": "Goats",
    "horses": "Horses",
    "farm-animals": "Farm animals",
}

# Singular form for headings like "More penguin cams".
ONE = {"cats": "cat", "dogs": "dog", "seals": "seal", "wildebeest-migration": "migration", "wolves": "wolf", "deer": "deer",
       "jellyfish": "jellyfish", "salmon": "salmon", "farm-animals": "farm animal", "tortoises": "giant tortoise"}


def one(key):
    if key in ONE:
        return ONE[key]
    name = ANIMALS[key].lower()
    return name[:-1] if name.endswith("s") else name


# (pattern on the cam name, animal keys). All matching rules apply.
RULES = [
    (r"penguin", ["penguins"]),
    (r"bald eagle|decorah eagle|trempealeau eagle|southwest florida eagle|eagle nest close|eagle pond|eagle nest, wildlife rescue|bald eagles", ["bald-eagles"]),
    (r"osprey|dunrovin nest", ["ospreys"]),
    (r"peregrine", ["peregrine-falcons"]),
    (r"stork", ["storks"]),
    (r"\bowl", ["owls"]),
    (r"hummingbird", ["hummingbirds"]),
    (r"puffin", ["puffins"]),
    (r"kestrel", ["kestrels"]),
    (r"feeder|feederwatch|bird buffet|garden birds|backyard wildlife|small birds|veranda bird|bird bath|bird feeding|garden wildlife, pretoria|creek water tank|nature cam|cardinal", ["backyard-birds"]),
    (r"brooks falls|anan bears|katmai|libearty|mansur the bear", ["brown-bears"]),
    (r"polar bear", ["polar-bears"]),
    (r"elephant", ["elephants"]),
    (r"giraffe", ["giraffes"]),
    (r"rhino", ["rhinos"]),
    (r"zebra", ["zebras"]),
    (r"crossing", ["wildebeest-migration"]),
    (r"tiger(?!.*shark)|dutchess the tiger|max the tiger", ["tigers"]),
    (r"\blions?\b", ["lions"]),
    (r"gorilla|bonobo|chimpanzee", ["great-apes"]),
    (r"giant panda", ["giant-pandas"]),
    (r"red panda", ["red-pandas"]),
    (r"sloth", ["sloths"]),
    (r"wol(f|ves)", ["wolves"]),
    (r"\bdeer\b", ["deer"]),
    (r"\belk\b", ["elk"]),
    (r"\bbats?\b|flying fox", ["bats"]),
    (r"raccoon", ["raccoons"]),
    (r"hedgehog", ["hedgehogs"]),
    (r"badger", ["badgers"]),
    (r"(?<!flying )\bfox(es)?\b", ["foxes"]),
    (r"squirrel", ["squirrels"]),
    (r"otter", ["otters"]),
    (r"\bseals?\b|sea lion", ["seals"]),
    (r"\borca", ["orcas"]),
    (r"manatee", ["manatees"]),
    (r"shark", ["sharks"]),
    (r"jell(y|ies)|sea nettle", ["jellyfish"]),
    (r"coral|reef|underwater pier|curaçao sea aquarium", ["coral-reefs"]),
    (r"kelp", ["kelp-forests"]),
    (r"salmon", ["salmon"]),
    (r"alligator", ["alligators"]),
    (r"tortoise", ["tortoises"]),
    (r"kitten|\bcats?\b(?!\s+eye)|felines", ["cats"]),
    (r"pupp|dog", ["dogs"]),
    (r"(?<!mountain )\bgoats?\b", ["goats"]),
    (r"horse|dunrovin ranch|riding centre", ["horses"]),
    (r"cattle|sheep|alpaca|chicken|farm sanctuary|syman says farms cam|ducks and goats", ["farm-animals"]),
]
_RX = [(re.compile(p, re.I), keys) for p, keys in RULES]


def guess_animals(name):
    out = []
    for rx, keys in _RX:
        if rx.search(name):
            out += [k for k in keys if k not in out]
    return out


HABITATS = {
    "safari": ("Safari", "African safari waterholes and plains"),
    "zoo": ("Zoos & sanctuaries", "zoos, sanctuaries and rescue centres"),
    "aqua": ("Aquariums & ocean", "aquariums, reefs and open ocean"),
    "birds": ("Birds & nests", "nests, colonies and feeders"),
    "wild": ("Forests & rivers", "forests, rivers and backyards"),
    "pets": ("Farms & rescues", "farms, shelters and animal rescues"),
}

CONTINENTS = ["Africa", "Asia", "Europe", "North America", "Latin America", "Oceania"]
