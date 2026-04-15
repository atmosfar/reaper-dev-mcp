#!/usr/bin/env python3
"""
Scrape ReaScript API documentation from local HTML file and export to JSON for MCP server.
Extracts ALL functions organized by language (C, EEL2, Lua, Python).
"""

import json
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

def parse_return_type_pair(pair_str: str) -> dict:
    """Parse a single return type pair (type name) from a multi-return signature."""
    pair_str = pair_str.strip()
    if not pair_str:
        return {"type": "", "name": None}
    
    # Check if there's a name (space-separated type and name)
    if ' ' in pair_str:
        parts = pair_str.split(' ', 1)
        return_type = parts[0]
        return_name = parts[1] if len(parts) > 1 else None
        return {"type": return_type, "name": return_name}
    else:
        # No name, just type
        return {"type": pair_str, "name": None}

def parse_parameters(params_str: str, has_types: bool = True) -> list:
    """Parse function parameters from a string. Handles nested parentheses.
    
    Args:
        params_str: Parameter string
        has_types: If True, expects "type name" format. If False, expects just "name" format.
    """
    # Decode HTML entities like &amp; -> &
    params_str = params_str.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    
    if not params_str or params_str.strip() == "":
        return []
    
    params = []
    # Split by comma but not inside parentheses
    depth = 0
    parts = []
    current = ""
    for char in params_str:
        if char == "(":
            depth += 1
            current += char
        elif char == ")":
            depth -= 1
            current += char
        elif char == "," and depth == 0:
            parts.append(current.strip())
            current = ""
        else:
            current += char
    if current.strip():
        parts.append(current.strip())
    
    for part in parts:
        if not part:
            continue
        
        if has_types:
            # Pattern: type name or type* name
            # Handle EEL2 reference parameters like "&time" or "int &shape"
            part = part.strip()
            
            # Check if it starts with "&" (EEL2 reference parameter)
            if part.startswith("&"):
                # Just a reference, no type
                param_name = part[1:].strip()
                params.append({"type": "void", "name": param_name})
                continue
            
            # Check if it has "&" in the middle (e.g., "int &shape")
            if "&" in part:
                # Split on "&" and take the type
                type_part = part.split("&")[0].strip()
                name_part = part.split("&")[1].strip()
                params.append({"type": type_part, "name": name_part})
                continue
            
            param_match = re.match(r"(\w+(?:\s*\*)?)\s+(\w+)", part)
            if param_match:
                param_type = param_match.group(1).strip()
                param_name = param_match.group(2).strip()
                params.append({"type": param_type, "name": param_name})
            else:
                # Just type, no name
                params.append({"type": part, "name": None})
        else:
            # Just names, no types
            param_match = re.match(r"(\w+)", part)
            if param_match:
                params.append({"type": "void", "name": param_match.group(1).strip()})
            else:
                params.append({"type": "void", "name": part})
    
    return params

def parse_lua_signature(sig_text: str) -> dict:
    """Parse Lua function signature with potential multiple return values.
    
    Lua format: type1 name1, type2 name2, ... = reaper.function_name(params)
    Or: type1 name1 = reaper.function_name(params)
    Or: reaper.function_name(params) for void
    """
    # Remove HTML tags and language prefixes like "Lua: "
    sig_text = re.sub(r"<[^>]+>", "", sig_text).strip()
    sig_text = re.sub(r"^[A-Za-z]+:\s*", "", sig_text).strip()
    
    # Check if it has return values (contains '=' before the opening parenthesis)
    # Return value assignments are at the start: type1 name1 = function(params)
    # Parameters may contain '=' like default values: usecliprect=1
    paren_pos = sig_text.find('(')
    if paren_pos == -1:
        paren_pos = len(sig_text)
    return_values_section = sig_text[:paren_pos]
    if "=" not in return_values_section:
        # Single return type or void

        # Try with <return_type> reaper.Func(params) format (standard API functions)
        match = re.match(r"(\w+)\s+(reaper\.\w+|RPR_[\w_]+|[\w_]+\.\w+)\s*\((.*)\)", sig_text)
        if match:
            return_type = match.group(1)  # e.g., "boolean", "int"
            func_name = match.group(2)  # Full prefix: reaper.Func or RPR_Func
            params_str = match.group(3)
            return {
                "return_values": [{"type": return_type, "name": None}],
                "name": func_name,
                "parameters": parse_parameters(params_str, has_types=True),
            }
        # Try with namespace.func(params) format (language-specific functions without return type prefix)
        match = re.match(r"([\w_]+\.\w+)\s*\((.*)\)", sig_text)
        if match:
            func_name = match.group(1)  # Full prefix: gfx.func
            params_str = match.group(2)
            return {
                "return_values": [{"type": "void", "name": None}],
                "name": func_name,
                "parameters": parse_parameters(params_str, has_types=False),
            }
        return {"return_values": [], "name": "", "parameters": []}
    
    # Has return values - extract everything before '='
    eq_pos = sig_text.find("=")
    return_part = sig_text[:eq_pos]
    params_part = sig_text[eq_pos + 1 :].strip()
    
    # Extract function name from params_part (fully prefixed: reaper.Func, RPR_Func, gfx.func)
    func_name_match = re.search(r'(?:reaper\.[\w_]+|RPR_[\w_]+|[\w_]+\.\w+)', params_part)
    func_name = func_name_match.group(0) if func_name_match else return_part.split('.')[-1] if return_part else None
    
    # Parse return types
    return_values = [parse_return_type_pair(rt) for rt in return_part.split(",")]
    
    # Extract parameters (skip function name and opening paren)
    if func_name:
        start = params_part.find(func_name) + len(func_name) + 1  # +1 for '('
        params_part = params_part[start:].strip()
    
    return {
        "return_values": return_values,
        "name": func_name,  # Already fully prefixed
        "parameters": parse_parameters(params_part),
    }

def parse_python_signature(sig_text: str) -> dict:
    """Parse Python function signature with potential multiple return values.
    
    Python format: (type1 name1, type2 name2, ...) = RPR_function_name(params)
    Or: (type1 name1) = RPR_function_name(params)
    Or: RPR_function_name(params) for void
    """
    # Remove HTML tags and language prefixes like "Python: "
    sig_text = re.sub(r"<[^>]+>", "", sig_text).strip()
    sig_text = re.sub(r"^[A-Za-z]+:\s*", "", sig_text).strip()
    
    # Check if it has return values (starts with '(' and contains '=')
    if sig_text.startswith("(") and "=" in sig_text:
        # Extract everything between '(' and ')'
        paren_end = sig_text.find(")")
        if paren_end == -1:
            return {"return_values": [], "name": "", "parameters": []}
        
        return_part = sig_text[1 : paren_end]  # Remove '('
        params_part = sig_text[paren_end + 1 :].strip()
        
        # Extract function name from signature (fully prefixed: RPR_FunctionName)
        func_name_match = re.search(r"RPR_[\w_]+", sig_text)
        func_name = func_name_match.group(0) if func_name_match else None
        
        # Parse return types
        return_values = [parse_return_type_pair(rt) for rt in return_part.split(",")]
        
        # Extract parameters (skip function name and opening paren)
        if func_name:
            start = params_part.find(func_name) + len(func_name) + 1  # +1 for '('
            params_part = params_part[start:].strip()
            # Remove trailing closing paren if present
            params_part = params_part.rstrip(')').strip()
            
            # Parse parameter names
            param_names = [p.strip() for p in params_part.split(",") if p.strip()]
            
            # Create parameters with types from return_values
            parameters = []
            for i, param_name in enumerate(param_names):
                if i < len(return_values):
                    rt = return_values[i]
                    # Use the type from return_values, or "void" if no type
                    param_type = rt["type"] if rt["type"] else "void"
                    parameters.append({"type": param_type, "name": param_name})
                else:
                    parameters.append({"type": "void", "name": param_name})
            
            return {
                "return_values": return_values,
                "name": func_name,
                "parameters": parameters,
            }
        else:
            return {
                "return_values": return_values,
                "name": func_name,
                "parameters": [],
            }
    
    # Single return type (no parentheses)
    # Handle both: return_type RPR_function(params) and RPR_function(params)
    match = re.match(r"(\w+(?:\s*\*)?)\s*(RPR_[\w_]+)\s*\((.*?)\)", sig_text)
    if match:
        return {
            "return_values": [{"type": match.group(1), "name": None}],
            "name": match.group(2),  # Full prefix: RPR_FunctionName
            "parameters": parse_parameters(match.group(3)),
        }
    
    # Handle RPR_function(params) without return type (language-specific functions)
    match = re.match(r"(RPR_[\w_]+)\s*\((.*?)\)", sig_text)
    if match:
        return {
            "return_values": [{"type": "void", "name": None}],
            "name": match.group(1),  # Full prefix: RPR_FunctionName
            "parameters": parse_parameters(match.group(2), has_types=False),
        }
    
    return {"return_values": [], "name": "", "parameters": []}

def parse_standard_signature(sig_text: str) -> dict:
    """Parse C/EEL2 function signature with single return type.
    
    Format: return_type function_name(params)
    """
    # Remove HTML tags and language prefixes like "C: " or "EEL2: "
    sig_text = re.sub(r"<[^>]+>", "", sig_text).strip()
    # Remove language prefix (e.g., "C: " or "EEL2: ")
    prefix_match = re.match(r"^.*?:(\s+)", sig_text)
    if prefix_match:
        sig_text = sig_text[len(prefix_match.group(0)):]
    
    # Pattern: return_type function_name(params)
    # Handle HTML entities like &amp; which become &
    match = re.match(r"(\w+(?:\s*\*)?)\s+(\w+)\s*\((.*?)\)", sig_text)
    if not match:
        # Try with & in parameter types (allow no space before ()
        match = re.match(r"(\w+(?:\s*\*)?)\s+(\w+)\s*\((.*)\)", sig_text)
    
    if match:
        return_type = match.group(1).strip()
        name = match.group(2).strip()
        # group(3) may not exist for all patterns
        params_str = match.group(3).strip() if len(match.groups()) > 2 else match.group(2)
        
        # If return_type looks like a function name (starts with lowercase letter), it's actually the function name
        # This handles EEL2 functions like floor(value) where floor is the function name
        # Known return types: bool, int, float, double, char, void, string, byte, short, long, unsigned, signed
        known_return_values = {'bool', 'int', 'float', 'double', 'char', 'void', 'string', 'byte', 'short', 'long', 'unsigned', 'signed'}
        if return_type.islower() and return_type not in known_return_values:
            # This is likely an EEL2 function without return type
            # Parameters are just names, not type name pairs
            return {
                "return_values": [{"type": "void", "name": None}],
                "name": return_type,
                "parameters": parse_parameters(params_str, has_types=False),
            }
        
        return {
            "return_values": [{"type": return_type, "name": None}],
            "name": name,
            "parameters": parse_parameters(params_str),
        }
    
    # Try without return type (EEL2 functions like floor(value))
    match = re.match(r"(\w+)\((.*)\)", sig_text)
    if match:
        return {
            "return_values": [{"type": "void", "name": None}],
            "name": match.group(1),
            "parameters": parse_parameters(match.group(2), has_types=False),
        }
    
    return {"return_values": [], "name": "", "parameters": []}

def parse_function_signature(sig_text: str, language: str = "c") -> dict:
    """Parse a function signature to extract return types, name, and parameters."""
    if language == "lua":
        return parse_lua_signature(sig_text)
    elif language == "python":
        return parse_python_signature(sig_text)
    else:
        return parse_standard_signature(sig_text)

def scrape_all_functions(file_path: str) -> dict:
    """Scrape all functions from a local HTML file."""
    with open(file_path, "r", encoding="utf-8") as f:
        html = f.read()
    
    # Store all functions with all their language signatures
    all_functions = {}
    
    # Also organize by language for easy lookup
    functions_by_language = {
        "c": [],
        "eel2": [],
        "lua": [],
        "python": [],
    }
    
    # First find all function names from tables
    # Use <a name="#..."> to get actual function names, not section headers
    # <a href="#..."> links in descriptions point to related functions, not the function definition
    func_name_pattern = r'<a name="([^"]+)"'
    func_names = re.findall(func_name_pattern, html)
    
    # Filter out section headers (like eel_list, lua_list, python_list)
    func_names = [name for name in func_names if not name.endswith('_list')]
    
    # Get unique function names
    func_names = sorted(set(func_names))
    
    # Now find the full context for each function
    for func_id in func_names:
        # Find the full div block for this function, including description
        # Match up to the next <a name= tag (e.g., <a name="GetExePath")
        full_match = re.search(
            rf'<a name="{re.escape(func_id)}"[^>]*>.*?<a name="[a-zA-Z0-9_]+"[^>]*>',
            html,
            re.DOTALL
        )
        
        if not full_match:
            continue
        
        # Get description - look for text after the function signature
        # There are two cases:
        # 1. Main API functions: description after p_func div
        # 2. Language-specific functions: description after the signature
        
        # Check if there are language-specific divs (c_func, e_func, l_func, p_func)
        has_lang_divs = any(div in full_match.group(0) for div in ['c_func', 'e_func', 'l_func', 'p_func'])
        
        if has_lang_divs:
            # Main API functions: description after p_func div
            div_positions = [m.start() for m in re.finditer(r'</div>', full_match.group(0))]
            last_div = div_positions[-1] if div_positions else 0
            after_div = full_match.group(0)[last_div + 5:]  # +5 for '</div>'
            
            # Find the next <a name= tag (skip <a href= tags within description)
            # Description may contain <a href="#..."> tags pointing to related functions
            next_a_match = re.search(r'<a name=', after_div)
            if next_a_match:
                desc_match = re.match(r'(.+?)<a name=', after_div, re.DOTALL)
                if desc_match:
                    description = desc_match.group(1).strip()
                    # Strip all HTML tags but keep text content
                    description = re.sub(r'<[^>]+>', '', description).strip()
                    # Remove leading > characters from tag stripping
                    description = description.lstrip('>').strip()
                    # Handle both <br> tags and literal br text
                    description = description.replace('<br>', '\n').replace('<BR>', '\n').replace(' br', ' ').replace(' br>', ' ').replace('br>', ' ').replace('br', '\n').replace('BR>', ' ').replace('BR', '\n').strip()
                    description = description.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
                    description = ' '.join(description.split())
                else:
                    description = ""
            else:
                description = ""
        else:
            # Language-specific functions: description after signature
            # Find the signature (EEL2: <code>...</code> or Lua: <code>...</code> or Python: <code>...</code>)
            sig_match = re.search(r'(?:EEL2|Lua|Python): <code>.*?</code>', full_match.group(0), re.DOTALL)
            if sig_match:
                after_sig = full_match.group(0)[sig_match.end():]
                
                # Find the next <a name= tag (skip <a href= tags within description)
                next_a_match = re.search(r'<a name=', after_sig)
                if next_a_match:
                    desc_match = re.match(r'(.+?)<a name=', after_sig, re.DOTALL)
                    if desc_match:
                        description = desc_match.group(1).strip()
                        # Strip all HTML tags but keep text content
                        description = re.sub(r'<[^>]+>', '', description).strip()
                        # Remove leading > characters from tag stripping
                        description = description.lstrip('>').strip()
                        # Handle both <br> tags and literal br text
                        description = description.replace('<br>', '\n').replace('<BR>', '\n').replace(' br', ' ').replace(' br>', ' ').replace('br>', ' ').replace('br', '\n').replace('BR>', ' ').replace('BR', '\n').strip()
                        description = description.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
                        description = ' '.join(description.split())
                    else:
                        description = ""
                else:
                    description = ""
            else:
                description = ""
        
        # Initialize function data
        if func_id not in all_functions:
            all_functions[func_id] = {
                "name": func_id,
                "description": description,
                "signatures": {},
                                "available_in": [],
            }
        
        func_data = all_functions[func_id]
        
        # Parse signature from language-specific section
        # Format: EEL2: <code>abs(value)</code> or Lua: <code>gfx.deltablit(...)</code> or Python: <code>RPR_atexit(...)</code>
        lang_sig_match = re.search(r'(EEL2|Lua|Python): <code>(.*?)</code>', full_match.group(0), re.DOTALL)
        if lang_sig_match:
            lang = lang_sig_match.group(1).lower()
            lang_sig = lang_sig_match.group(2).strip()
            sig = parse_function_signature(lang_sig, lang)
            if sig:
                func_data["signatures"][lang] = sig
                if lang not in func_data["available_in"]:
                    func_data["available_in"].append(lang)
                    functions_by_language[lang].append(func_id)
        
        # Extract signatures for each language
        # C/C++
        c_func_match = re.search(r'<div class="c_func">.*?</div>', full_match.group(0), re.DOTALL)
        if c_func_match:
            c_code = re.sub(r'<[^>]+>', '', c_func_match.group(0)).strip()
            sig = parse_function_signature(c_code, "c")
            if sig:
                func_data["signatures"]["c"] = sig
                if "c" not in func_data["available_in"]:
                    func_data["available_in"].append("c")
                    functions_by_language["c"].append(func_id)
        
        # EEL2
        e_func_match = re.search(r'<div class="e_func">.*?</div>', full_match.group(0), re.DOTALL)
        if e_func_match:
            e_code = re.sub(r'<[^>]+>', '', e_func_match.group(0)).strip()
            sig = parse_function_signature(e_code, "eel2")
            if sig:
                func_data["signatures"]["eel2"] = sig
                if "eel2" not in func_data["available_in"]:
                    func_data["available_in"].append("eel2")
                    functions_by_language["eel2"].append(func_id)
        
        # Lua
        l_func_match = re.search(r'<div class="l_func">.*?</div>', full_match.group(0), re.DOTALL)
        if l_func_match:
            l_code = re.sub(r'<[^>]+>', '', l_func_match.group(0)).strip()
            sig = parse_function_signature(l_code, "lua")
            if sig:
                func_data["signatures"]["lua"] = sig
                if "lua" not in func_data["available_in"]:
                    func_data["available_in"].append("lua")
                    functions_by_language["lua"].append(func_id)
        
        # Python
        p_func_match = re.search(r'<div class="p_func">.*?</div>', full_match.group(0), re.DOTALL)
        if p_func_match:
            p_code = re.sub(r'<[^>]+>', '', p_func_match.group(0)).strip()
            sig = parse_function_signature(p_code, "python")
            if sig:
                func_data["signatures"]["python"] = sig
                if "python" not in func_data["available_in"]:
                    func_data["available_in"].append("python")
                    functions_by_language["python"].append(func_id)
    
    return {
        "all_functions": all_functions,
        "by_language": functions_by_language,
    }

def fetch_from_official_docs(output_path: Path) -> bool:
    """Fetch ReaScript docs from official REAPER website."""
    url = "https://www.reaper.fm/sdk/reascript/reascripthelp.html"
    print(f"Fetching from {url}...", file=sys.stderr)
    
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            html_content = response.read().decode('utf-8')
            output_path.write_text(html_content, encoding='utf-8')
            print(f"Saved to {output_path}", file=sys.stderr)
            return True
    except urllib.error.URLError as e:
        print(f"Error fetching URL: {e.reason}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error saving HTML: {e}", file=sys.stderr)
        return False

def main():
    """Scrape ReaScript API from local HTML file and export to JSON."""
    
    # Default hardcoded path
    html_path = Path(__file__).parent.parent / "reascripthelp.html"
    
    # Check for command-line argument (filepath)
    if len(sys.argv) > 1:
        html_path = Path(sys.argv[1])
        if not html_path.is_absolute():
            html_path = Path(__file__).parent.parent / html_path
    
    print(f"Looking for HTML file: {html_path}", file=sys.stderr)
    
    # Check if HTML file exists
    if not html_path.exists():
        print(f"Error: HTML file not found at expected path:", file=sys.stderr)
        print(f"  {html_path.absolute()}", file=sys.stderr)
        print(file=sys.stderr)
        print("Options to proceed:", file=sys.stderr)
        print("  a) Generate local file from Reaper (recommended - includes third-party plugins)", file=sys.stderr)
        print("     In Reaper: Help > ReaScript Documentation", file=sys.stderr)
        print("     Then save the opened page as HTML in the expected path above.", file=sys.stderr)
        print(file=sys.stderr)
        print("  b) Fetch from official REAPER docs (missing third-party plugin functions)", file=sys.stderr)
        print(f"     URL: https://www.reaper.fm/sdk/reascript/reascripthelp.html", file=sys.stderr)
        print(file=sys.stderr)
        
        choice = input("Choose option [a/b] or 'q' to quit: ").strip().lower()
        
        if choice == 'b':
            print(file=sys.stderr)
            fetch_from_official_docs(html_path)
            if not html_path.exists():
                sys.exit(1)
        elif choice == 'a':
            print(f"\nPlease generate the HTML file and place it at:", file=sys.stderr)
            print(f"  {html_path.absolute()}", file=sys.stderr)
            print("Then run this script again.", file=sys.stderr)
            sys.exit(1)
        else:
            print("Exiting.", file=sys.stderr)
            sys.exit(1)
    
    scraped_data = scrape_all_functions(str(html_path))
    
    all_functions = scraped_data["all_functions"]
    functions_by_language = scraped_data["by_language"]
    
    functions_list = list(all_functions.values())
    
    data = {
        "functions": functions_list,
        "functions_by_language": functions_by_language,
        "scraped_at": datetime.now().isoformat(),
        "total_unique_functions": len(all_functions),
        "counts_by_language": {
            lang: len(funcs) for lang, funcs in functions_by_language.items()
        },
    }
    
    output_path = Path(__file__).parent.parent / "data" / "reascript-api.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    
    print(f"Saved ReaScript API data to {output_path}", file=sys.stderr)
    print(f"Total unique functions: {data['total_unique_functions']}", file=sys.stderr)
    print("\nFunctions by language:", file=sys.stderr)
    for lang, count in data["counts_by_language"].items():
        print(f"  {lang.upper()}: {count}", file=sys.stderr)

if __name__ == "__main__":
    main()
