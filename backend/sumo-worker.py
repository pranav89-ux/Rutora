"""JSON-lines adapter around SUMO/TraCI for location-based micro simulations."""
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path

import sumolib
import traci


ROOT = Path(__file__).resolve().parent.parent
RUN_ROOT = ROOT / "backend" / "data" / "sumo"
RUN_ROOT.mkdir(parents=True, exist_ok=True)
state = None


def meters_per_degree(latitude):
    return 111320.0, 111320.0 * math.cos(math.radians(latitude))


def speed_for(road):
    value = road.get("maxspeed")
    if value:
        import re
        match = re.search(r"\d+(?:\.\d+)?", str(value))
        if match:
            speed = float(match.group(0))
            if "mph" in str(value).lower():
                speed *= 1.60934
            if 5 <= speed <= 160:
                return speed / 3.6
    values = {"motorway": 33.3, "trunk": 27.8, "primary": 19.4, "secondary": 16.7,
              "tertiary": 13.9, "residential": 11.1, "living_street": 5.5, "service": 8.3}
    return values.get(road.get("highway"), 11.1)


def restricted(road):
    access = road.get("motorcarAccess") or road.get("motorVehicleAccess") or road.get("vehicleAccess") or road.get("access")
    return str(access or "").lower() in {"no", "private", "destination", "delivery", "customers", "agricultural", "forestry", "permit"}


def create_network(model, run_dir):
    roads = model.get("roads", [])
    center_lat = model["location"]["latitude"]
    center_lon = model["location"]["longitude"]
    north_scale, east_scale = meters_per_degree(center_lat)
    records = []
    node_roads = {}
    for road in roads:
        coords = road.get("coordinates") or []
        node_ids = road.get("nodeIds") or []
        if len(coords) < 2:
            continue
        if len(node_ids) != len(coords):
            node_ids = ["xy_" + str(round(lat, 7)) + "_" + str(round(lon, 7)) for lat, lon in coords]
        node_ids = [str(item) for item in node_ids]
        record = {"road": road, "coords": coords, "nodes": node_ids, "edgeIds": []}
        records.append(record)
        for node_id in set(node_ids):
            node_roads.setdefault(node_id, set()).add(str(road["id"]))

    junctions = {node_id for node_id, way_ids in node_roads.items() if len(way_ids) > 1}
    for record in records:
        junctions.add(record["nodes"][0])
        junctions.add(record["nodes"][-1])

    node_coords = {}
    for record in records:
        for node_id, (lat, lon) in zip(record["nodes"], record["coords"]):
            node_coords.setdefault(node_id, (lat, lon))
    node_file = run_dir / "nodes.nod.xml"
    edge_file = run_dir / "roads.edg.xml"
    node_root = ET.Element("nodes")
    for node_id in junctions:
        point = node_coords[node_id]
        x = (point[1] - center_lon) * east_scale
        y = (point[0] - center_lat) * north_scale
        ET.SubElement(node_root, "node", id="n" + node_id, x=f"{x:.2f}", y=f"{y:.2f}", type="priority")

    edge_root = ET.Element("edges")
    for record in records:
        road = record["road"]
        coords = record["coords"]
        nodes = record["nodes"]
        anchors = [i for i, node_id in enumerate(nodes) if node_id in junctions]
        if anchors[0] != 0:
            anchors.insert(0, 0)
        if anchors[-1] != len(nodes) - 1:
            anchors.append(len(nodes) - 1)
        lanes = max(1, min(6, int(road.get("lanes") or 1)))
        speed = speed_for(road)
        denied = "passenger" if restricted(road) else ""
        one_way = bool(road.get("oneway"))
        reverse_only = bool(road.get("reverseOneway"))
        for segment, (first, last) in enumerate(zip(anchors, anchors[1:])):
            if first == last or nodes[first] == nodes[last]:
                continue
            shape = " ".join(f"{(lon-center_lon)*east_scale:.2f},{(lat-center_lat)*north_scale:.2f}" for lat, lon in coords[first:last+1][1:-1])
            base = f"w{road['id']}_{segment}"
            forward = {
                "id": base + "_f", "from": "n" + nodes[first], "to": "n" + nodes[last],
                "numLanes": str(lanes), "speed": f"{speed:.2f}", "priority": "2",
            }
            if shape:
                forward["shape"] = shape
            if denied:
                forward["disallow"] = denied
            if not reverse_only:
                ET.SubElement(edge_root, "edge", forward)
                record["edgeIds"].append(forward["id"])
            if reverse_only or not one_way:
                reverse = dict(forward)
                reverse["id"] = base + "_r"
                reverse["from"], reverse["to"] = forward["to"], forward["from"]
                reverse["shape"] = " ".join(reversed(shape.split())) if shape else ""
                if not reverse["shape"]:
                    reverse.pop("shape", None)
                ET.SubElement(edge_root, "edge", reverse)
                record["edgeIds"].append(reverse["id"])

    ET.ElementTree(node_root).write(node_file, encoding="utf-8", xml_declaration=True)
    ET.ElementTree(edge_root).write(edge_file, encoding="utf-8", xml_declaration=True)
    network_file = run_dir / "network.net.xml"
    command = [sumolib.checkBinary("netconvert"), "--node-files", str(node_file), "--edge-files", str(edge_file),
               "--output-file", str(network_file), "--no-turnarounds", "true", "--tls.guess", "true",
               "--tls.default-type", "static", "--junctions.join-dist", "0", "--geometry.remove", "false"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    if result.returncode != 0 or not network_file.exists():
        raise RuntimeError("SUMO could not connect the OpenStreetMap roads: " + (result.stderr or result.stdout)[-1600:])
    return records, network_file


def stop_engine():
    global state
    if state is not None:
        try:
            traci.close(False)
        except Exception:
            pass
        state = None


def initialize(message):
    global state
    stop_engine()
    sim_id = str(message["id"])
    run_dir = RUN_ROOT / sim_id
    run_dir.mkdir(parents=True, exist_ok=True)
    model = message["model"]
    records, network_file = create_network(model, run_dir)
    types_file = run_dir / "vehicles.add.xml"
    types_root = ET.Element("additional")
    rain = float(message.get("rainMmH") or 0)
    speed_factor = max(0.65, 1.0 - min(0.28, rain * 0.0025))
    ET.SubElement(types_root, "vType", id="urban", vClass="passenger", carFollowModel="IDM", laneChangeModel="LC2013",
                  accel="2.4", decel="4.5", emergencyDecel="8", sigma="0.35", tau="1.15", minGap="2.5",
                  length="4.8", maxSpeed="40", speedFactor=f"{speed_factor:.3f}", speedDev="0.08",
                  lcStrategic="1.0", lcCooperative="0.8", lcSpeedGain="1.0", lcKeepRight="0.8")
    ET.ElementTree(types_root).write(types_file, encoding="utf-8", xml_declaration=True)
    config = run_dir / "simulation.sumocfg"
    cfg_root = ET.Element("configuration")
    input_tag = ET.SubElement(cfg_root, "input")
    ET.SubElement(input_tag, "net-file", value=str(network_file))
    ET.SubElement(input_tag, "additional-files", value=str(types_file))
    time_tag = ET.SubElement(cfg_root, "time")
    ET.SubElement(time_tag, "begin", value="0")
    ET.SubElement(time_tag, "step-length", value="1")
    ET.SubElement(time_tag, "end", value="86400")
    ET.ElementTree(cfg_root).write(config, encoding="utf-8", xml_declaration=True)

    sumo = sumolib.checkBinary("sumo")
    traci.start([sumo, "-c", str(config), "--no-step-log", "true", "--duration-log.disable", "true",
                 "--time-to-teleport", "180", "--max-depart-delay", "30", "--seed", str(random.randint(1, 2**30))],
                stdout=subprocess.DEVNULL)
    net = sumolib.net.readNet(str(network_file), withInternal=False)
    passenger_edges = [edge.getID() for edge in net.getEdges() if edge.allows("passenger") and edge.getLength() >= 25]
    valid_roads = {str(record["road"]["id"]): record["edgeIds"] for record in records if record["edgeIds"]}
    if len(passenger_edges) < 2:
        stop_engine()
        raise RuntimeError("The selected OSM area does not contain enough connected roads for SUMO traffic.")
    state = {
        "id": sim_id, "model": model, "records": records, "roadEdges": valid_roads,
        "passengerEdges": passenger_edges, "net": net, "runDir": str(run_dir),
        "eastScale": meters_per_degree(model["location"]["latitude"])[1],
        "northScale": meters_per_degree(model["location"]["latitude"])[0],
        "netOffset": net.getLocationOffset(),
        "centerLat": model["location"]["latitude"], "centerLon": model["location"]["longitude"],
        "demand": max(10, min(3000, int(message.get("trafficVolume") or 320))),
        "nextDeparture": 0.0, "vehicleSequence": 0, "routeSequence": 0, "departedTotal": 0, "arrivedTotal": 0, "collisionsTotal": 0, "manualRouteEdges": [],
        "manualDemand": 0, "closedRoadIds": set(),
        "edgeRoad": {edge_id: road_id for road_id, edge_ids in valid_roads.items() for edge_id in edge_ids},
    }
    # Pre-roll demand for two minutes so the first visible frame contains cars already moving.
    for _ in range(120):
        step_simulation()
    return snapshot()


def create_demand_if_due():
    if state is None:
        return
    now = traci.simulation.getTime()
    rate = state["demand"] + state["manualDemand"]
    headway = 3600.0 / max(1, rate)
    attempts = 0
    while state["nextDeparture"] <= now and attempts < 8:
        attempts += 1
        candidates = state["manualRouteEdges"] or state["passengerEdges"]
        success = False
        for _ in range(16):
            start = random.choice(candidates)
            end = random.choice(state["passengerEdges"])
            if start == end:
                continue
            try:
                result = traci.simulation.findRoute(start, end, vType="urban")
                if len(result.edges) < 2:
                    continue
                route_id = f"route_{state['routeSequence']}"
                vehicle_id = f"veh_{state['vehicleSequence']}"
                state["routeSequence"] += 1
                state["vehicleSequence"] += 1
                traci.route.add(route_id, list(result.edges))
                traci.vehicle.add(vehicle_id, route_id, typeID="urban", depart="now", departLane="best", departSpeed="desired")
                success = True
                break
            except traci.TraCIException:
                continue
        # Advance the departure clock even if this candidate had no viable route.
        state["nextDeparture"] += headway
        if not success:
            continue


def step_simulation():
    create_demand_if_due()
    traci.simulationStep()
    state["departedTotal"] += len(traci.simulation.getDepartedIDList())
    state["arrivedTotal"] += len(traci.simulation.getArrivedIDList())
    state["collisionsTotal"] += traci.simulation.getCollidingVehiclesNumber()


def snapshot():
    if state is None:
        raise RuntimeError("SUMO simulation is not initialized.")
    model = state["model"]
    counts = {str(road["id"]): 0 for road in model["roads"]}
    mean_speeds = {}
    for road_id, edge_ids in state["roadEdges"].items():
        counts[road_id] = sum(traci.edge.getLastStepVehicleNumber(edge_id) for edge_id in edge_ids)
        measured = [traci.edge.getLastStepMeanSpeed(edge_id) for edge_id in edge_ids if traci.edge.getLastStepVehicleNumber(edge_id) > 0]
        if measured:
            mean_speeds[road_id] = round(sum(measured) / len(measured) * 3.6, 1)
    vehicles = []
    speeds = []
    for index, vehicle_id in enumerate(traci.vehicle.getIDList()):
        try:
            x, y = traci.vehicle.getPosition(vehicle_id)
            # netconvert normalizes local network coordinates; undo its recorded shift.
            offset_x, offset_y = state["netOffset"]
            lon = state["centerLon"] + (x - offset_x) / state["eastScale"]
            lat = state["centerLat"] + (y - offset_y) / state["northScale"]
            edge_id = traci.vehicle.getRoadID(vehicle_id)
            road_id = state["edgeRoad"].get(edge_id)
            speed_kph = traci.vehicle.getSpeed(vehicle_id) * 3.6
            vehicle_index = int(vehicle_id.rsplit("_", 1)[-1]) if vehicle_id.rsplit("_", 1)[-1].isdigit() else index
            vehicles.append({"id": vehicle_index, "roadId": road_id, "position": [lat, lon], "heading": traci.vehicle.getAngle(vehicle_id), "speedKph": round(speed_kph, 1)})
            speeds.append(speed_kph)
        except traci.TraCIException:
            continue
    return {"roadCounts": counts, "roadMeanSpeedKph": mean_speeds, "vehicles": vehicles[:500], "activeVehicles": len(vehicles),
            "averageSpeedKph": round(sum(speeds) / len(speeds)) if speeds else 0,
            "simulatedSeconds": traci.simulation.getTime(), "departed": state["departedTotal"],
            "arrived": state["arrivedTotal"], "collisions": state["collisionsTotal"]}


def apply_closed_roads(road_ids):
    ids = set(str(item) for item in road_ids)
    for road_id in ids - state["closedRoadIds"]:
        for edge_id in state["roadEdges"].get(road_id, []):
            try:
                traci.edge.setDisallowed(edge_id, ["passenger"])
            except traci.TraCIException:
                pass
    for road_id in state["closedRoadIds"] - ids:
        for edge_id in state["roadEdges"].get(road_id, []):
            try:
                traci.edge.setDisallowed(edge_id, [])
            except traci.TraCIException:
                pass
    state["closedRoadIds"] = ids
    for vehicle_id in list(traci.vehicle.getIDList()):
        try:
            traci.vehicle.rerouteTraveltime(vehicle_id)
        except traci.TraCIException:
            continue


def handle(message):
    action = message.get("action")
    if action == "init":
        return initialize(message)
    if state is None:
        raise RuntimeError("SUMO simulation is not initialized.")
    if action == "step":
        for _ in range(max(1, min(4, int(message.get("steps") or 1)))):
            step_simulation()
        return snapshot()
    if action == "configure":
        state["demand"] = max(10, min(3000, int(message.get("trafficVolume") or 320)))
        return snapshot()
    if action == "manual-route":
        ids = message.get("roadIds") or []
        state["manualRouteEdges"] = [edge for road_id in ids for edge in state["roadEdges"].get(str(road_id), [])]
        target = max(0, min(3000, int(message.get("vehicles") or 0)))
        state["manualDemand"] = target
        return snapshot()
    if action == "close-roads":
        apply_closed_roads(message.get("roadIds") or [])
        return snapshot()
    if action == "reset":
        saved = {"id": state["id"], "model": state["model"], "trafficVolume": state["demand"], "rainMmH": message.get("rainMmH", 0)}
        return initialize(saved)
    if action == "close":
        stop_engine()
        return {"closed": True}
    if action == "health":
        return {"available": True, "sumoVersion": sumolib.version.split()[0] if hasattr(sumolib, "version") else "installed", "engine": "SUMO / TraCI"}
    raise RuntimeError("Unknown SUMO worker action: " + str(action))


for line in sys.stdin:
    try:
        request = json.loads(line)
        request_id = request.get("requestId")
        result = handle(request)
        print(json.dumps({"requestId": request_id, "ok": True, "result": result}, separators=(",", ":")), flush=True)
    except Exception as error:
        details = str(error)
        if request.get("action") == "init":
            details = "Could not initialize SUMO from this OpenStreetMap area: " + details
        print(json.dumps({"requestId": request.get("requestId"), "ok": False, "error": details}, separators=(",", ":")), flush=True)

stop_engine()
