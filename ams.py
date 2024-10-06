import os
import sys
import subprocess

def install_packages():
    """Verifica ou cria ambiente virtual e instala pacotes do requirements.txt"""
    venv_dir = ".venv"

    # Verifica se o ambiente virtual já existe
    if not os.path.exists(venv_dir):
        print("Criando o ambiente virtual...")
        subprocess.check_call([sys.executable, "-m", "venv", venv_dir])

    # Ativar o ambiente virtual no macOS/Linux
    activate_script = os.path.join(venv_dir, "bin", "activate_this.py")
    
    # Ativar o ambiente virtual no Windows
    if os.name == 'nt':
        activate_script = os.path.join(venv_dir, "Scripts", "activate_this.py")

    with open(activate_script) as file:
        exec(file.read(), dict(__file__=activate_script))

    # Instala os pacotes necessários do requirements.txt
    requirements_file = "requirements.txt"
    if os.path.exists(requirements_file):
        print("Instalando pacotes do requirements.txt...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", requirements_file])
    else:
        print(f"Arquivo {requirements_file} não encontrado. Certifique-se de que ele está no diretório do projeto.")
        sys.exit(1)

if __name__ == "__main__":
    # Verifica e instala pacotes automaticamente
    install_packages()

    # A partir daqui, o ambiente virtual está ativado e os pacotes estão instalados
    print("Pacotes instalados e ambiente virtual ativado.")


# Caminho para os dados do GDAL instalados via Homebrew (ou qualquer outro caminho)
script_directory = os.path.dirname(os.path.realpath(__file__))
gdal_data_path = '/opt/homebrew/Cellar/gdal/3.9.2_1/share/gdal'

# Definir a variável de ambiente GDAL_DATA
os.environ['GDAL_DATA'] = gdal_data_path

# Diretório raiz onde está o arquivo KML e a pasta 'tifs'
root_directory = script_directory

# Caminho para o arquivo KML que está na mesma pasta do executável
kml_file = os.path.join(root_directory, 'rota.kml')

# Verifica se o arquivo KML existe
if not os.path.exists(kml_file):
    print(f"Arquivo KML 'rota.kml' não encontrado no diretório {root_directory}.")
    sys.exit(1)  # Encerra o programa se o arquivo não for encontrado
else:
    print(f"Arquivo KML encontrado no diretório: {kml_file}")

# Caminho para a pasta 'tifs' dentro da pasta raiz
tifs_directory = os.path.join(root_directory, 'tifs')

# Verifica se a pasta 'tifs' existe
if not os.path.exists(tifs_directory):
    print(f"Pasta 'tifs' não encontrada no diretório {root_directory}.")
    sys.exit(1)  # Encerra o programa se a pasta não for encontrada
else:
    print(f"Pasta 'tifs' encontrada no diretório: {tifs_directory}")

    
import lxml.etree as etree
import rasterio
import math
import pyproj
import geopy.distance
from glob import glob
from shapely.geometry import Point, Polygon
from shapely.ops import transform, unary_union

# Função para carregar a rota de um arquivo KML usando lxml
def load_kml_route(file_path):
    try:
        with open(file_path, 'rb') as file:
            doc = file.read()

        root = etree.fromstring(doc)

        placemarks = root.findall('.//{http://www.opengis.net/kml/2.2}Placemark')
        waypoints = []

        for placemark in placemarks:
            name = placemark.find('{http://www.opengis.net/kml/2.2}name')
            lookat = placemark.find('.//{http://www.opengis.net/kml/2.2}LookAt')
            if lookat is not None:
                lat = float(lookat.find('{http://www.opengis.net/kml/2.2}latitude').text)
                lon = float(lookat.find('{http://www.opengis.net/kml/2.2}longitude').text)
                waypoint_name = name.text if name is not None else f"Waypoint {len(waypoints) + 1}"
                waypoints.append((waypoint_name, lat, lon))
        if len(waypoints) == 0:
            print("Nenhum waypoint encontrado no arquivo KML.")
        return waypoints
    except Exception as e:
        print(f"Erro ao carregar o KML: {e}")
        return []

# Função para criar um círculo ao redor do waypoint
def calculate_circle(lat, lon, radius_nm):
    radius_km = radius_nm * 1.852  # Conversão de NM para KM
    
    # Projeção atualizada usando CRS
    proj_wgs84 = pyproj.CRS.from_epsg(4326)  # WGS84 latitude/longitude
    
    # Criar o transformer adequado
    transformer_to_meters = pyproj.Transformer.from_crs(proj_wgs84, pyproj.CRS(proj="aeqd", lat_0=lat, lon_0=lon))
    transformer_back_to_wgs84 = pyproj.Transformer.from_crs(pyproj.CRS(proj="aeqd", lat_0=lat, lon_0=lon), proj_wgs84)

    point = Point(lon, lat)
    
    # Transformando para a projeção em metros, criando o buffer e retornando para WGS84
    buffer = transform(transformer_to_meters.transform, point).buffer(radius_km * 1000)
    circle = transform(transformer_back_to_wgs84.transform, buffer)
    
    return circle

# Função para criar um retângulo ao longo da perna
def calculate_rectangle(lat1, lon1, lat2, lon2, width_nm):
    bearing_of_leg = calculate_bearing(lat1, lon1, lat2, lon2)
    perp_bearing_1 = (bearing_of_leg + 90) % 360
    perp_bearing_2 = (bearing_of_leg + 270) % 360
    
    lat_offset1, lon_offset1 = offset_point(lat1, lon1, perp_bearing_1, width_nm / 2)
    lat_offset2, lon_offset2 = offset_point(lat1, lon1, perp_bearing_2, width_nm / 2)
    lat_offset3, lon_offset3 = offset_point(lat2, lon2, perp_bearing_1, width_nm / 2)
    lat_offset4, lon_offset4 = offset_point(lat2, lon2, perp_bearing_2, width_nm / 2)

    rectangle = Polygon([(lon_offset1, lat_offset1), (lon_offset3, lat_offset3), (lon_offset4, lat_offset4), (lon_offset2, lon_offset2)])
    return rectangle

# Função para calcular o azimute entre dois pontos
def calculate_bearing(lat1, lon1, lat2, lon2):
    d_lon = math.radians(lon2 - lon1)
    lat1 = math.radians(lat1)
    lat2 = math.radians(lat2)

    x = math.sin(d_lon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(d_lon)
    
    bearing = math.atan2(x, y)
    bearing = math.degrees(bearing)
    return (bearing + 360) % 360

# Função para calcular um ponto deslocado
def offset_point(lat, lon, bearing, distance_nm):
    distance_km = distance_nm * 1.852
    destination = geopy.distance.distance(kilometers=distance_km).destination((lat, lon), bearing)
    return destination.latitude, destination.longitude

# Função para encontrar a maior e a menor elevação em um arquivo .tif
def find_max_min_elevation_in_area(polygon, tif_files):
    max_elevation = -float('inf')
    min_elevation = float('inf')
    
    for tif_file in tif_files:
        try:
            with rasterio.open(tif_file) as dataset:
                bounds = dataset.bounds
                
                if polygon.intersects(Polygon([(bounds.left, bounds.bottom), (bounds.left, bounds.top), 
                                               (bounds.right, bounds.top), (bounds.right, bounds.bottom)])):
                    min_lon, min_lat, max_lon, max_lat = polygon.bounds
                    
                    # Recorte os dados dentro dos limites do polígono
                    window = rasterio.windows.from_bounds(min_lon, min_lat, max_lon, max_lat, transform=dataset.transform)
                    data = dataset.read(1, window=window)

                    # Filtra as alturas válidas
                    elevations = data * 3.28084  # metros para pés
                    valid_elevations = elevations[~dataset.read_masks(1, window=window) == 0]  # Ignora valores mascarados
                    if valid_elevations.size > 0:
                        max_elevation = max(max_elevation, valid_elevations.max())
                        min_elevation = min(min_elevation, valid_elevations.min())
        except Exception as e:
            print(f"Erro ao processar o arquivo {tif_file}: {e}")

    return max_elevation if max_elevation != -float('inf') else None, min_elevation if min_elevation != float('inf') else None

# Função para calcular a AMS
def calculate_ams(max_elevation, min_elevation):
    if max_elevation is None or min_elevation is None:
        return None
    
    diff = max_elevation - min_elevation
    # Arredonda para a primeira centena cheia maior
    rounded_max = math.ceil(max_elevation / 100) * 100
    
    # Lógica de cálculo da AMS
    if diff <= 1000:
        return rounded_max + 1000
    else:
        return rounded_max + 2000

# Função principal para processar as elevações para as pernas da rota
def find_max_min_elevation_for_route(kml_file, tif_files):
    waypoints = load_kml_route(kml_file)

    if len(waypoints) < 2:
        print("Não há waypoints suficientes para processar as pernas.")
        return None

    relevant_info = []

    for i in range(len(waypoints) - 1):
        wp1_name, lat1, lon1 = waypoints[i]
        wp2_name, lat2, lon2 = waypoints[i + 1]

        # Círculo no waypoint A
        circle_A = calculate_circle(lat1, lon1, 10)
        
        # Círculo no waypoint B
        circle_B = calculate_circle(lat2, lon2, 10)
        
        # Retângulo ao longo da perna A-B
        rectangle = calculate_rectangle(lat1, lon1, lat2, lon2, 20)

        # Unir as áreas (círculo A, retângulo, círculo B)
        geometries = [circle_A, rectangle, circle_B]
        valid_geometries = [geom for geom in geometries if geom.is_valid]

        # Realiza a união das geometrias válidas
        combined_area = unary_union(valid_geometries)

        # Encontrar as elevações máxima e mínima para toda a área combinada
        max_elevation, min_elevation = find_max_min_elevation_in_area(combined_area, tif_files)
        
        if max_elevation is not None and min_elevation is not None:
            ams = calculate_ams(max_elevation, min_elevation)
            relevant_info.append(f"{wp1_name} --> {wp2_name}: {max_elevation:.2f} pés (Máx), {min_elevation:.2f} pés (Mín), AMS: {ams} pés")

    # Retornar apenas a informação relevante
    return relevant_info

if __name__ == "__main__":
    # Coletando todos os arquivos .tif na pasta 'tifs'
    tif_files = glob(os.path.join(tifs_directory, '*.tif'))

    if not os.path.exists(kml_file):
        print(f"Arquivo KML 'rota.kml' não encontrado no diretório {root_directory}.")
    elif not os.path.exists(tifs_directory):
        print(f"Pasta 'tifs' não encontrada no diretório {root_directory}.")
    elif not tif_files:
        print(f"Nenhum arquivo .tif encontrado na pasta 'tifs'.")
    else:
        # Processar a rota e exibir os resultados
        result = find_max_min_elevation_for_route(kml_file, tif_files)

        if result:
            for info in result:
                print(info)